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
 * - **超 5MB base64 自动压缩**（CHANGELOG_72）：Anthropic API base64 上限 5MB。原图 raw
 *   > ~3.6MB（base64 ≈ 4.8MB safety threshold）就走 canvas 重编码 + 必要时 downscale，
 *   把 png 截图压成 jpeg；GIF 动图无法 canvas 重编码（只能拿首帧），超阈值直接拒
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

/**
 * 单图 base64 后字节上限。Anthropic API 限 5MB（`image/jpeg|png|gif|webp` 都按 base64
 * size 算），留 200KB safety margin（headers / 多附件 / 浮点误差）后取 5MB - 200KB。
 *
 * 触发压缩的判断直接看 base64 长度：base64 长度 ≈ ceil(raw/3)*4，等价于 raw > ~3.6MB
 * 必走压缩。GIF 动图不能 canvas 重编码（首帧丢动），超阈值直接 reject。
 */
const MAX_BASE64_BYTES_FOR_API = 5 * 1024 * 1024 - 200 * 1024;

/** 缩略图最长边像素（gif 不 resize 避免动图变首帧静图）。 */
const THUMB_MAX_DIM = 200;

/**
 * 压缩尝试参数序列：从无损到激进 downscale，按顺序逐档尝试，第一个 ≤ 阈值即返回。
 * scale=1.0 开头表示先只降 quality 不动尺寸；不行再砍 scale。
 */
const COMPRESS_ATTEMPTS: Array<{ scale: number; quality: number }> = [
  { scale: 1.0, quality: 0.85 },
  { scale: 1.0, quality: 0.7 },
  { scale: 1.0, quality: 0.55 },
  { scale: 0.7, quality: 0.7 },
  { scale: 0.7, quality: 0.55 },
  { scale: 0.5, quality: 0.7 },
  { scale: 0.5, quality: 0.55 },
];

export interface UploadedAttachmentEntry {
  /** 本地 id，用于 React key + remove */
  id: string;
  /** 200px 长边的缩略图 dataUrl（用于 UI 显示） */
  thumbnailDataUrl: string;
  mime: string;
  bytes: number;
  /** 原始文件名（用于 hover tooltip / a11y） */
  name?: string;
  /**
   * 触发压缩前的原始字节数。仅当压缩后才有值（即 originalBytes !== bytes 才显示），
   * UI 在 tooltip / aria-label 提示用户「已自动压缩 X MB → Y MB」。
   */
  originalBytes?: number;
}

export interface UseImageAttachmentsResult {
  attachments: UploadedAttachmentEntry[];
  /** 错误：单张图被拒 / 总大小超限 / 非 image / 压缩失败。展示后自动清，调用方决定渲染 */
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
 * File → 完整 dataUrl（"data:mime;base64,..."），失败抛错让 caller catch 设错误态。
 * 用 dataUrl 形式因为后续要喂给 `<img>` decode；纯 base64 还得自己拼前缀。
 */
async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('reader result not string'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

/** 从 "data:mime;base64,xxx" 取出后半段 base64（不含前缀）。 */
function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) throw new Error('dataUrl missing comma');
  return dataUrl.slice(idx + 1);
}

/**
 * 算 base64 字符串的 raw byte 长度（解码后字节数）。
 * 公式：每 4 base64 字符 = 3 raw 字节；尾部 `=` padding 各扣 1。
 * 不实际解码，纯算字符长度，避免对大 string 多创建一份 ArrayBuffer。
 */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/** dataUrl → HTMLImageElement，失败抛错。 */
async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

/**
 * 把图按指定 scale + jpeg quality 编码到 canvas 再读出 base64。
 * 失败返回 null（caller 跳过本档继续下一个尝试），成功返回 `{base64, bytes}`（mime 固定 jpeg）。
 */
function encodeToJpegBase64(
  img: HTMLImageElement,
  scale: number,
  quality: number,
): { base64: string; bytes: number } | null {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // jpeg 不支持 alpha → 用白底（避免透明区域被 chrome 默认黑底污染）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
  const base64 = stripDataUrlPrefix(dataUrl);
  return { base64, bytes: base64ByteLength(base64) };
}

/**
 * 读图 → 必要时压缩到 base64 ≤ MAX_BASE64_BYTES_FOR_API。
 *
 * 三层路径：
 * 1. 原图 base64 ≤ 阈值 → 直接返回（最佳路径，无质量损失）
 * 2. GIF 超阈值 → reject（动图压缩会丢动，宁可让用户决定要不要换静图）
 * 3. 其他超阈值 → canvas 重编码为 JPEG，按 quality 0.85→0.55、scale 1.0→0.5 序列尝试，
 *    第一个 ≤ 阈值返回；全档都不行 → reject 让 UI 报错
 *
 * 返回 `{base64, mime, bytes}` 已就绪喂给后端 IPC（mime 可能从 png 变 jpeg，bytes 是实际 raw byte）。
 */
async function readAndMaybeCompress(
  file: File,
  mime: string,
): Promise<{ base64: string; mime: string; bytes: number; compressed: boolean }> {
  const dataUrl = await readFileAsDataUrl(file);
  const originalBase64 = stripDataUrlPrefix(dataUrl);

  // Path 1: 原图够小直接走（绝大多数 < 3.6MB 截图命中这条路径，无质量损失）
  if (originalBase64.length <= MAX_BASE64_BYTES_FOR_API) {
    return { base64: originalBase64, mime, bytes: file.size, compressed: false };
  }

  // Path 2: GIF 动图不能 canvas 重编码（首帧丢动）→ 直接拒
  if (mime === 'image/gif') {
    throw new Error(
      `gif 动图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 API 5MB base64 上限，无法自动压缩（压会丢动）。请手动转静图或缩小尺寸`,
    );
  }

  // Path 3: 走 canvas 重编码 JPEG，按尝试序列降档
  const img = await loadImageFromDataUrl(dataUrl);
  for (const { scale, quality } of COMPRESS_ATTEMPTS) {
    const out = encodeToJpegBase64(img, scale, quality);
    if (!out) continue;
    if (out.base64.length <= MAX_BASE64_BYTES_FOR_API) {
      return { base64: out.base64, mime: 'image/jpeg', bytes: out.bytes, compressed: true };
    }
  }
  throw new Error(
    `图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 即使最低质量 + 50% 缩放仍超过 API 5MB 上限。请手动裁剪或更换图片`,
  );
}

/**
 * canvas resize 到 200px 长边，返回新 dataUrl。
 *
 * gif 跳过 resize（canvas 只能拿首帧 → 动图变静图丢失原意），直接用原图 dataUrl
 * （gif 通常不大，不 resize 内存影响有限）。
 */
async function makeThumbnail(file: File, mime: string): Promise<string> {
  const fullDataUrl = await readFileAsDataUrl(file);
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
      // REVIEW_35 MED-D-claude-3：toDataURL('image/jpeg') 不支持 alpha → 透明像素被编为黑色。
      // 与 encodeToJpegBase64 (line 155-158) 同款先填白底再 drawImage，保证 png 透明区域
      // 缩略图显示白底而非黑底（macOS 截图常带透明，旧版黑底误以为图片损坏）。
      // 注：drawImage 已经发生 → 重新创建顺序
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
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
  // REVIEW_35 follow-up rH R2-M3: mountedRef + generationRef 防 unmount race。
  // - mountedRef: unmount 后 add() 内 await 完 readAndMaybeCompress/makeThumbnail 不再 setState
  //   （React 不报「setState on unmounted」warning，但状态 ref 写入是真 leak）
  // - generationRef: clear()/remove(id) bump generation；resolve 后 generation 不匹配则丢弃
  //   防 in-flight add 在用户 clear 后「复活」附件
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  // 卸载时清掉 ref + mark unmounted
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      generationRef.current++;
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
      // 进 add 时拍 generation 快照；resolve 后比对，不匹配（已被 clear/remove/unmount）则丢弃
      const generationAtStart = generationRef.current;
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
        try {
          // 压缩与缩略图并发跑（缩略图始终用原图算，与压缩独立）
          const [compressed, thumb] = await Promise.all([
            readAndMaybeCompress(file, file.type),
            makeThumbnail(file, file.type),
          ]);
          // REVIEW_35 follow-up rH R2-M3: await resolve 后检查 mounted + generation
          if (!mountedRef.current || generationRef.current !== generationAtStart) {
            // unmount 或 clear 期间触发的 add → 直接丢弃，不污染 state / ref
            continue;
          }
          const id = nextId();
          // REVIEW_35 R2 HIGH-D-R2-1：旧版「闭包变量 admitted + setAttachments updater 内写」
          // 在 React 18 batching 下不可靠 — updater 延迟到下次 render 跑，admitted 仍是初始值
          // true → fullBase64Ref.set 仍执行 → 即使 reducer 后来 reject 不进 attachments，
          // **ref 已留下孤儿** (rG-claude Node sim 实测 5×7MB 并发 → attachments 4 OK + ref 5 = 1 孤儿)。
          // 修法：fullBase64Ref.set **也移到 setAttachments updater 内**，与 attachments 状态原子更新
          // （违反 React 纯 updater 契约理论上 strict mode 双跑会出现 ref set 两次 → Map.set 同 key
          // 是幂等的所以无害；超限时不 set 直接跳过）。
          let admittedThisRound = false;
          setAttachments((prev) => {
            const currentTotal = prev.reduce((s, a) => s + a.bytes, 0);
            if (currentTotal + compressed.bytes > MAX_TOTAL_BYTES) {
              return prev;
            }
            // 在 updater 内同步写 ref 与 newEntries 局部追踪（admittedThisRound 仅给 errors 路径用）
            fullBase64Ref.current.set(id, compressed.base64);
            admittedThisRound = true;
            return [
              ...prev,
              {
                id,
                thumbnailDataUrl: thumb,
                mime: compressed.mime,
                bytes: compressed.bytes,
                name: file.name,
                ...(compressed.compressed ? { originalBytes: file.size } : {}),
              },
            ];
          });
          if (admittedThisRound) {
            newEntries.push({
              id,
              thumbnailDataUrl: thumb,
              mime: compressed.mime,
              bytes: compressed.bytes,
              name: file.name,
              ...(compressed.compressed ? { originalBytes: file.size } : {}),
            });
          } else {
            errors.push(
              `${file.name}：总附件超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`,
            );
          }
        } catch (err) {
          errors.push(`${file.name}：${(err as Error).message}`);
        }
      }
      // REVIEW_35 LOW-D-codex-1：成功添加新 entry 时清旧错误，避免 stale error 一直挂在 UI
      // REVIEW_35 follow-up rH R2-M3: setError 前同样检查 mounted + generation
      if (mountedRef.current && generationRef.current === generationAtStart) {
        if (newEntries.length > 0 && errors.length === 0) {
          setError(null);
        } else if (errors.length > 0) {
          setError(errors.join('；'));
        }
      }
    },
    [],  // REVIEW_35 HIGH-D1：deps=[] 让闭包不再持有 attachments 引用，避免误用闭包 stale state
  );

  const remove = useCallback((id: string): void => {
    // REVIEW_35 follow-up rH R2-M3: bump generation 让 in-flight add() 完成后丢弃，
    // 避免被 remove 的 entry 因 add() resolve 后又被 setAttachments 复活
    generationRef.current++;
    fullBase64Ref.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback((): void => {
    // REVIEW_35 follow-up rH R2-M3: bump generation 同 remove
    generationRef.current++;
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
