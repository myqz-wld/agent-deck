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
 * 判断 WebP 文件头 32 字节是否标记为 animated（纯函数，便于单测）。
 *
 * WebP 容器格式（RIFF）：`"RIFF"(4) + size(4) + "WEBP"(4) + chunk...`。只有扩展格式
 * `VP8X` chunk 才可能带动画；其 flags byte（文件偏移 20）的 ANIM bit（0x02）置位即动图。
 * simple lossy(`VP8 `)/lossless(`VP8L`) 永远静态。头不足 / 非 webp / 非 VP8X 一律返回 false。
 */
export function isAnimatedWebpHeader(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  // "RIFF"
  if (head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46) return false;
  // "WEBP" at offset 8
  if (head[8] !== 0x57 || head[9] !== 0x45 || head[10] !== 0x42 || head[11] !== 0x50) return false;
  // chunk fourcc at offset 12 必须是 "VP8X"（扩展格式，只有它能带动画）
  if (head[12] !== 0x56 || head[13] !== 0x50 || head[14] !== 0x38 || head[15] !== 0x58) return false;
  // VP8X flags byte 在 offset 20（12-15 fourcc + 16-19 chunk size + 20 flags）；ANIM bit = 0x02
  return (head[20] & 0x02) !== 0;
}

/**
 * 检测 WebP 是否为动图（animated）。
 *
 * REVIEW_102 MED-3（reviewer-codex + lead web 规范逻辑链验证）：白名单允许 image/webp，
 * 但超 base64 阈值的压缩路径只拦了 GIF，animated WebP 会进 canvas → JPEG → 只剩首帧 +
 * mime 变 image/jpeg，用户发给模型的内容与原图静默不一致。canvas.drawImage 对动图只绘制
 * 当前帧 + jpeg 格式无动画能力是 web 规范确定性事实。
 *
 * 只读文件头 32 字节（isAnimatedWebpHeader 纯逻辑判定），失败（读不到 / 非 webp / 太短）
 * 一律返回 false（保守：检测失败不拦截，让后续 canvas 路径处理）。
 */
async function detectAnimatedWebp(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    return isAnimatedWebpHeader(head);
  } catch {
    return false;
  }
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
 * 四层路径：
 * 1. 原图 base64 ≤ 阈值 → 直接返回（最佳路径，无质量损失）
 * 2. GIF 超阈值 → reject（动图压缩会丢动，宁可让用户决定要不要换静图）
 * 2.5 animated WebP 超阈值 → reject（同 GIF：canvas 重编码丢动 + mime 变 jpeg 静默失真）
 * 3. 其他超阈值 → canvas 重编码为 JPEG，按 quality 0.85→0.55、scale 1.0→0.5 序列尝试，
 *    第一个 ≤ 阈值返回；全档都不行 → reject 让 UI 报错
 *
 * REVIEW_102 INFO（reviewer-claude）：dataUrl 由 caller 预读一次后传入（不再自己 readFileAsDataUrl），
 * 与 makeThumbnail 共享同一份，消除「同一文件读两遍 + 2× base64 string 瞬时内存」。
 *
 * 返回 `{base64, mime, bytes}` 已就绪喂给后端 IPC（mime 可能从 png 变 jpeg，bytes 是实际 raw byte）。
 */
async function readAndMaybeCompress(
  file: File,
  mime: string,
  dataUrl: string,
): Promise<{ base64: string; mime: string; bytes: number; compressed: boolean }> {
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

  // Path 2.5: animated WebP 同 GIF —— canvas → JPEG 会丢动 + mime 静默变 jpeg（REVIEW_102 MED-3）。
  // 仅对 webp 做文件头检测（静态 webp 仍走 Path 3 正常压缩）。
  if (mime === 'image/webp' && (await detectAnimatedWebp(file))) {
    throw new Error(
      `webp 动图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 API 5MB base64 上限，无法自动压缩（压会丢动）。请手动转静图或缩小尺寸`,
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
 *
 * REVIEW_102 INFO（reviewer-claude）：fullDataUrl 由 caller 预读传入，与 readAndMaybeCompress
 * 共享同一份，消除同文件读两遍。
 */
async function makeThumbnail(mime: string, fullDataUrl: string): Promise<string> {
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
  // CHANGELOG_<X> 30MB-误报 fix:attachmentsRef 同步映射 attachments state,让 add() 在
  // setAttachments **之前** 用 ref 预算 currentTotal — 不再依赖 setState(updater) 的
  // 同步语义。React 18 setState(updater) 是 enqueue 等当前 callback 结束才 flush,
  // 旧版 `let admittedThisRound = false; setAttachments(prev => {...; admittedThisRound = true})`
  // 后立即 `if (admittedThisRound)` 检查时 updater 永远没跑,flag 永远 false → 用户粘
  // **一张** 图就误报「总附件超过 30MB 上限」(Node sim 实测 100% 复现)。
  // 修法:add 内用 attachmentsRef 直接算 currentTotal,通过则 ref + state 一起手动更新,
  // updater 退化为简单 `prev => [...prev, entry]` 不再判断 limit。
  const attachmentsRef = useRef<UploadedAttachmentEntry[]>([]);
  // REVIEW_35 follow-up rH R2-M3: mountedRef + generationRef 防 unmount race。
  // - mountedRef: unmount 后 add() 内 await 完 readAndMaybeCompress/makeThumbnail 不再 setState
  //   （React 不报「setState on unmounted」warning，但状态 ref 写入是真 leak）
  // - generationRef: clear()/unmount bump generation；resolve 后 generation 不匹配则丢弃，
  //   防 in-flight add 在用户 clear（整批取消）/unmount 后「复活」附件。
  //   REVIEW_102 MED-1：remove(id) **不**再 bump（详 remove() 注释 —— 单图删除不应连坐
  //   同批 in-flight 兄弟；整批取消才用 bump）。
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  // attachmentsRef 与 attachments state 同步:commit phase 跑,让外部「我」拿 ref 反查
  // currentTotal 时与最新 state 一致(add/remove/clear 内手动 sync ref 是 fast path,
  // useEffect 是兜底防遗漏 / 未来新增 setAttachments 入口忘了同步 ref)。
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // 卸载时清掉 ref + mark unmounted
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      generationRef.current++;
      fullBase64Ref.current.clear();
      attachmentsRef.current = [];
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
          // REVIEW_102 INFO（reviewer-claude）：先读一次 dataUrl 共享给压缩 + 缩略图两条路径，
          // 消除同文件读两遍 + 2× base64 string 瞬时内存。canvas 编码仍并发（共享同一份 dataUrl）。
          const dataUrl = await readFileAsDataUrl(file);
          const [compressed, thumb] = await Promise.all([
            readAndMaybeCompress(file, file.type, dataUrl),
            makeThumbnail(file.type, dataUrl),
          ]);
          // REVIEW_35 follow-up rH R2-M3: await resolve 后检查 mounted + generation
          if (!mountedRef.current || generationRef.current !== generationAtStart) {
            // unmount 或 clear 期间触发的 add → 直接丢弃，不污染 state / ref
            continue;
          }
          const id = nextId();
          // CHANGELOG_<X> 30MB-误报 fix:用 attachmentsRef 在 setAttachments **之前**
          // 预算 currentTotal,不再依赖 React 18 setState(updater) 的同步语义。
          //
          // 旧版「闭包 admittedThisRound flag + setAttachments updater 内 mutate flag」
          // 在 React 18 下 100% 失效:setState(updater) 是 enqueue 等当前 callback 结束
          // 才 flush,`if (admittedThisRound)` 紧跟在 setAttachments 之后(同 tick sync code),
          // updater 永远还没跑,flag 永远 false → 用户粘 1 张 5MB 图也误报「总附件超过 30MB
          // 上限」(/tmp/admit-flag-race.mjs Node sim 100% 复现)。
          //
          // REVIEW_35 R2 HIGH-D-R2-1 的「ref 孤儿」race 修法仍保留意图:fullBase64Ref.set
          // 与 attachments 加 entry 必须原子。本修法把判断 + ref.set + state push 都收口
          // 到 ref 同步路径(ref 立即更新 → state setAttachments(prev => [...prev, entry]) 必
          // 成功,不再有 reject 路径 → ref 不会孤儿)。**为下一 iter 同步**:attachmentsRef.current
          // 立刻指向新数组,for 循环下一 iter 用最新值算 currentTotal。
          const currentTotal = attachmentsRef.current.reduce((s, a) => s + a.bytes, 0);
          if (currentTotal + compressed.bytes > MAX_TOTAL_BYTES) {
            errors.push(
              `${file.name}：总附件超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`,
            );
            continue;
          }
          const entry: UploadedAttachmentEntry = {
            id,
            thumbnailDataUrl: thumb,
            mime: compressed.mime,
            bytes: compressed.bytes,
            name: file.name,
            ...(compressed.compressed ? { originalBytes: file.size } : {}),
          };
          // 同步:ref + fullBase64 在 setAttachments 之前手动更新,for 循环下一 iter 用
          // 最新 ref currentTotal。setAttachments updater 退化为简单 push(无 limit 判断)。
          fullBase64Ref.current.set(id, compressed.base64);
          attachmentsRef.current = [...attachmentsRef.current, entry];
          setAttachments((prev) => [...prev, entry]);
          newEntries.push(entry);
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
    // REVIEW_102 MED-1（reviewer-claude 独立命中 + lead sim 复现 + 复活不可达铁证）：
    // remove() **不再** bump generationRef。
    //
    // 旧实现 bump generation 是过度取消：本意「避免被删 entry 因 add() resolve 后复活」，
    // 但该复活场景不可达 —— entry 的 id 是在 add() 内 `await Promise.all([compress,thumb])`
    // **之后** line 327 nextId() 才生成，in-flight（仍在 await）的图还没 id、UI 列表里没有
    // 它、用户根本点不到「删」它；能被 remove 的一定是已 push 完成（同步走完 359-362）的
    // entry，它的 add 处理早已结束，不存在 resolve-after-remove 复活。
    //
    // 而 bump generation 的副作用是误伤：多图批量上传时 entry 逐张 push（line 361 在 for 内），
    // 删第 1 张时其余 file[1]/file[2] 可能仍在 await；bump 让整批 generationAtStart 失配 →
    // line 323 把它们静默 continue 丢弃（无 error 无提示）。用户只删 1 张却丢了同批其余几张。
    // 修法：remove 只删该 id（同步 ref + state），不动 generation；整批取消仍由 clear()/unmount
    // 的 bump 负责（那才是「丢弃所有 in-flight」的正确语义）。/tmp/img-med1-fix.mjs 3 场景实证。
    fullBase64Ref.current.delete(id);
    // 同步 ref + state(为下一次 add() 用 ref 算 currentTotal 时取最新值)
    attachmentsRef.current = attachmentsRef.current.filter((a) => a.id !== id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback((): void => {
    // REVIEW_35 follow-up rH R2-M3: bump generation 同 remove
    generationRef.current++;
    fullBase64Ref.current.clear();
    attachmentsRef.current = [];
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
