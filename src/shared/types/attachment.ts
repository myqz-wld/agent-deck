/**
 * 跨进程共享：用户在输入框附带的图片 attachment 类型。
 *
 * 设计要点（与 file.ts 的 ImageSource 区分）：
 * - ImageSource (`{kind:'path'|'snapshot'}`) 是「Agent 写出/编辑的图」，承载在 file_changes 表
 * - 这里的 UploadedAttachment 是「用户从输入框发进来的图」，承载在 events.payload_json
 * - 用 `kind:'uploaded'` 命名让两套语义互不干扰
 *
 * IPC 流向：
 * 1. renderer 粘贴/拖放/上传 → 内存 base64 + canvas resize 缩略图（state 只存缩略图，
 *    完整 base64 通过 ref 持有避免大对象进 React state 触发整组件 re-render）
 * 2. send 时打包成 UploadedAttachmentInput[] 走 IPC 一次到主进程
 * 3. 主进程 writeUploadedImage 落盘到 <userData>/image-uploads/<uuid>.<ext> → UploadedAttachmentRef
 * 4. ref 喂给 adapter（claude SDK lazy readFile + base64 image block / codex SDK 直传 path）
 * 5. emit message event payload 含 attachments: UploadedAttachmentRef[]，detail view 渲染时
 *    走新 IPC `loadUploadedImage(path)` 取 dataUrl（**不复用** loadImageBlob 的 file_changes 白名单）
 */

/** renderer → IPC 入参：base64 + 元信息。ext 不让 renderer 传，主进程从 mime 反查。 */
export interface UploadedAttachmentInput {
  kind: 'image';
  /** 不含 `data:<mime>;base64,` 前缀的纯 base64 */
  base64: string;
  /** 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/heic' | 'image/heif' | 'image/svg+xml' */
  mime: string;
  /** renderer 上报的字节数，主进程会用 Buffer.from(base64,'base64').length 实测对账 */
  bytes: number;
}

/** 落盘后主进程持有 / 喂给 adapter / 进 events.payload 的引用形态。 */
export interface UploadedAttachmentRef {
  kind: 'uploaded';
  /** <userData>/image-uploads/<uuid>.<ext> 绝对路径 */
  path: string;
  mime: string;
  bytes: number;
}

/** sendMessage / createSession 共用 message envelope。text 单独算 100KB 上限不变。 */
export interface UserMessageEnvelope {
  text: string;
  attachments?: UploadedAttachmentInput[];
}
