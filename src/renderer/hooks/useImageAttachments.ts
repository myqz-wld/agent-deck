/**
 * useImageAttachments — 输入框图片附件管理（粘贴 / 拖放 / 上传按钮 三件套）。
 *
 * 设计要点：
 * - **完整 base64 不进 React state**（HIGH-2 修法）：30MB×N 进 state 会触发整组件 re-render。
 *   state 只存 `{id, thumbnailDataUrl, mime, bytes}` 用于 UI 显示；完整 base64 由 useRef Map 持有，
 *   send 时才取
 * - **缩略图 client-resize**：canvas 把图片压到 200px 长边，dataUrl 体积 ~10-50KB，
 *   每张缩略图渲染开销可忽略
 * - **mime 白名单收口在 hook 层**：renderer 在投递前就拒非 image / 非 4 种支持格式
 *   （IPC 层会再校验一次，hook 层主要给即时 UI 反馈）
 * - 共享给 ComposerSdk + NewSessionDialog，两个调用方 UI 形态对称
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadedAttachmentInput } from '@shared/types';

/** 与 main/ipc/_image-constants.ts ALLOWED_UPLOAD_MIMES 同步。Claude SDK 限制 4 种。 */
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 单图 20MB 上限（与 MAX_IMAGE_BYTES 对齐）。 */
const MAX_BYTES_PER_IMAGE = 20 * 1024 * 1024;

/** 总附件 30MB 上限（与 MAX_TOTAL_ATTACHMENTS_BYTES 对齐）。 */
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** 缩略图最长边像素（gif 不 resize 避免动图变首帧静图）。 */
const THUMB_MAX_DIM = 200;

export interface UploadedAttachmentEntry {
  /** 本地 id，用于 React key + remove */
  id: string;
  /** 200px 长边的缩略图 dataUrl（用于 UI 显示） */
  thumbnailDataUrl: string;
  mime: string;
  bytes: number;
  /** 原始文件名（用于 hover tooltip / a11y） */
  name?: string;
}

export interface UseImageAttachmentsResult {
  attachments: UploadedAttachmentEntry[];
  /** 错误：单张图被拒 / 总大小超限 / 非 image。展示后自动清，调用方决定渲染 */
  error: string | null;
  add: (files: FileList | File[] | null | undefined) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** UI 事件 handler — 直接绑到 textarea / drop zone */
  onPaste: (e: React.ClipboardEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  /** send 时调用：从 ref 取 fullBase64，转 IPC 入参形态 */
  toIpcInputs: () => UploadedAttachmentInput[];
  dismissError: () => void;
}

let __idSeq = 0;
const nextId = (): string => `att-${Date.now()}-${++__idSeq}`;

/**
 * 把 File 读成完整 base64（不带 dataUrl 前缀）。
 * 失败抛错让 caller catch + 设错误态。
 */
async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('reader result not string'));
        return;
      }
      // result 形如 "data:image/png;base64,iVBOR..."；去前缀只留 base64
      const idx = result.indexOf(',');
      if (idx === -1) {
        reject(new Error('dataUrl missing comma'));
        return;
      }
      resolve(result.slice(idx + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * canvas resize 到 200px 长边，返回新 dataUrl。
 *
 * gif 跳过 resize（canvas 只能拿首帧 → 动图变静图丢失原意），直接用原图 dataUrl
 * （gif 通常不大，不 resize 内存影响有限）。
 */
async function makeThumbnail(file: File, mime: string): Promise<string> {
  const fullDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== 'string') reject(new Error('not string'));
      else resolve(r);
    };
    reader.readAsDataURL(file);
  });
  if (mime === 'image/gif') return fullDataUrl;
  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(fullDataUrl); // 失败回退原图
    img.onload = () => {
      const ratio = Math.min(THUMB_MAX_DIM / img.width, THUMB_MAX_DIM / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(fullDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      // 缩略图统一 jpeg 0.7 压缩（ratio < 1 时节省体积；webp 浏览器支持但兼容性 jpeg 更稳）
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(fullDataUrl);
      }
    };
    img.src = fullDataUrl;
  });
}

export function useImageAttachments(): UseImageAttachmentsResult {
  const [attachments, setAttachments] = useState<UploadedAttachmentEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 完整 base64 仓库：不进 state 防止 30MB×N 触发整组件 re-render
  const fullBase64Ref = useRef<Map<string, string>>(new Map());

  // 卸载时清掉 ref（不必要，GC 会回收，但显式清更明确）
  useEffect(() => {
    return () => {
      fullBase64Ref.current.clear();
    };
  }, []);

  const add = useCallback(
    async (filesIn: FileList | File[] | null | undefined): Promise<void> => {
      if (!filesIn) return;
      const files = Array.from(filesIn).filter((f): f is File => f instanceof File);
      if (files.length === 0) return;
      const errors: string[] = [];
      const newEntries: UploadedAttachmentEntry[] = [];
      // 提前算总大小（含已有的），超限直接拒
      const existingTotal = attachments.reduce((s, a) => s + a.bytes, 0);
      let runningTotal = existingTotal;
      for (const file of files) {
        if (!ALLOWED_MIMES.has(file.type)) {
          errors.push(`${file.name || '(未命名)'}：仅支持 PNG / JPEG / GIF / WebP`);
          continue;
        }
        if (file.size > MAX_BYTES_PER_IMAGE) {
          errors.push(
            `${file.name}：单图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BYTES_PER_IMAGE / 1024 / 1024}MB 上限`,
          );
          continue;
        }
        if (runningTotal + file.size > MAX_TOTAL_BYTES) {
          errors.push(
            `总附件超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限（剩余可用 ${((MAX_TOTAL_BYTES - runningTotal) / 1024 / 1024).toFixed(1)}MB）`,
          );
          continue;
        }
        try {
          const [base64, thumb] = await Promise.all([
            readFileAsBase64(file),
            makeThumbnail(file, file.type),
          ]);
          const id = nextId();
          fullBase64Ref.current.set(id, base64);
          newEntries.push({
            id,
            thumbnailDataUrl: thumb,
            mime: file.type,
            bytes: file.size,
            name: file.name,
          });
          runningTotal += file.size;
        } catch (err) {
          errors.push(`${file.name}：读取失败 ${(err as Error).message}`);
        }
      }
      if (newEntries.length > 0) {
        setAttachments((prev) => [...prev, ...newEntries]);
      }
      if (errors.length > 0) {
        setError(errors.join('；'));
      }
    },
    [attachments],
  );

  const remove = useCallback((id: string): void => {
    fullBase64Ref.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback((): void => {
    fullBase64Ref.current.clear();
    setAttachments([]);
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void add(files);
      }
    },
    [add],
  );

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
      if (files.length > 0) {
        e.preventDefault();
        void add(files);
      }
    },
    [add],
  );

  const onDragOver = useCallback((e: React.DragEvent): void => {
    // preventDefault 让 drop 能触发；只在拖入图片时阻止默认（让普通文本拖动正常）
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
    }
  }, []);

  const toIpcInputs = useCallback((): UploadedAttachmentInput[] => {
    return attachments.map((a) => {
      const base64 = fullBase64Ref.current.get(a.id);
      if (!base64) {
        throw new Error(`attachment ${a.id} fullBase64 missing — 已被 GC 或 race`);
      }
      return {
        kind: 'image',
        base64,
        mime: a.mime,
        bytes: a.bytes,
      };
    });
  }, [attachments]);

  const dismissError = useCallback((): void => setError(null), []);

  return {
    attachments,
    error,
    add,
    remove,
    clear,
    onPaste,
    onDrop,
    onDragOver,
    toIpcInputs,
    dismissError,
  };
}
