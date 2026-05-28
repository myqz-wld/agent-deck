/**
 * 把 file_changes 表里存的 before_blob / after_blob（TEXT 列）按 kind 解码成 DiffPayload 真正的 before/after。
 * - 'image'  → JSON.parse 出 ImageSource 对象
 * - 其他 kind（'text' / 'pdf' 等）→ 原样字符串返回（与历史行为兼容）
 *
 * 解析失败 / blob == null → 返回 null，由对应 renderer 自行处理空态。
 */
export function decodeBlob(kind: string, blob: string | null): unknown {
  if (blob == null) return null;
  if (kind === 'image') {
    try {
      return JSON.parse(blob);
    } catch {
      return null;
    }
  }
  return blob;
}

/** 文件改动 kind 枚举 → 中文显示标签（text → 文本 / image → 图片 / pdf/json 等保大写）。
 *  用在 ChangeTimeline badge 等用户可见处,避免 raw `TEXT` / `IMAGE` 给用户。 */
export function fileKindLabel(kind: string): string {
  switch (kind) {
    case 'text':
      return '文本';
    case 'image':
      return '图片';
    case 'pdf':
      return 'PDF';
    case 'json':
      return 'JSON';
    case 'binary':
      return '二进制';
    default:
      return kind.toUpperCase();
  }
}
