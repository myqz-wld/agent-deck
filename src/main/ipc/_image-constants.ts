/**
 * 图片相关常量（ext / mime / size）。
 *
 * 抽出原因：原本只有 `ipc/images.ts` 用，现在 `store/image-uploads.ts` 也需要同款白名单和上限。
 * 集中后两个模块共享一份事实，避免后续添加新格式时漏改。
 */

/**
 * 历史 / mcp 工具图片渲染走 ImageLoadBlob 用的扩展名白名单（9 种）。
 * 不主动收紧——旧 file_changes / tool-use-start 行可能记录过 svg / bmp / heic 等。
 */
export const ALLOWED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.svg',
]);

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

/**
 * 用户上传图片白名单：Claude SDK Base64ImageSource.media_type 只接 4 种
 * （`'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'`），应用层主动收口，
 * 避免用户上传 .heic / .svg 后跑到 SDK 才报错。
 *
 * codex SDK `local_image` 文档没明说支持格式，但 vision 模型实际接 png/jpg/webp 等
 * 通用格式（不接 heic / svg），与 Claude 收紧到同一子集刚好。
 *
 * 未来想扩支持，需双 SDK 都验证通过，再动这两张表。
 */
export const ALLOWED_UPLOAD_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * mime → 优选 ext 反查表。同 mime 多 ext 时（如 image/jpeg 可以是 .jpg / .jpeg），固定一个：
 * - 用户传 image/jpeg → 落盘 .jpg（更短更通用）
 * - 用户传非白名单 mime → undefined（writeUploadedImage 拒）
 *
 * **不接受 renderer 传 ext**：杜绝 `.png\x00.exe` / `.svg ` 之类的扩展名注入绕过。
 */
export const PREFERRED_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** 单图字节上限：与既有 ipc/images.ts:41 对齐。20MB 足够覆盖普通截图 / 设计稿。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 单条 message 总附件字节上限：约 5-6 张大图。 */
export const MAX_TOTAL_ATTACHMENTS_BYTES = 30 * 1024 * 1024;
