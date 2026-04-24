/**
 * Payload 截断 helper：防止 tool-use-end 的 toolResult / Bash 大输出 / 文件 dump 等
 * 撑爆 SQLite 单行（默认 SQLITE_MAX_LENGTH ~ 1GB，但实际 long session 累积可破 GB）。
 *
 * 策略两层：
 * 1. 序列化前 shrink 已知大字段（toolResult / output / stdout / stderr / content / text），
 *    深度限制 3 层避免 cycle / 重对象树。单字段截到 8KB。
 * 2. 整体仍 > 256KB → 降级为 marker（__truncated + __originalBytes + __preview），
 *    保 SQL 写得下且能在 UI 看到「这条事件被截了」而不是默默丢失。
 *
 * 字节预算（REVIEW_4 H3）：
 * - **永远**用 `Buffer.byteLength(s, 'utf8')` 算字节，不混 `string.length`（UTF-16 code units）
 *   —— 中文 / emoji 实际 UTF-8 字节最高可达 length 的 3 倍，混用会让阈值悄悄被绕过 3×
 * - 切的时候用 utf-8 leading-byte 边界回退，避免切到 multi-byte sequence（例 emoji 4 字节）
 *   中间产生孤儿字节，下游 JSON.parse 不报错但 UI 渲染替换字符
 * - KNOWN_LARGE 数组分支对 element 递归，处理 Claude tool_result 真实嵌套结构
 *   `{type:'tool_result', content:[{type:'text', text:'...'}]}` 外层逃逸
 *
 * 不直接对超长 JSON 字符串做 slice：会破 JSON 结构，rowToEvent 的 JSON.parse 会炸。
 */

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_FIELD_BYTES = 8 * 1024;
const KNOWN_LARGE_FIELDS = new Set([
  'toolResult',
  'output',
  'stdout',
  'stderr',
  'content',
  'text',
]);

/**
 * UTF-8 字节安全截断：
 * - 用 `Buffer.byteLength(s, 'utf8')` 算字节，不用 `string.length`
 * - 切的时候避开 multi-byte sequence 中间（continuation byte = 10xxxxxx）
 * - 回退到最后一个 leading byte 之前，保证截出来的子串仍是合法 utf-8
 *
 * 例：'🦄x' 的 utf-8 是 `f0 9f a6 84 78`（5 字节），切到 max=2 直接返回 ''
 * （第 0/1 字节都是 emoji 的 continuation 区，回退到 0），不会切出孤儿。
 */
function truncateStringByBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  // utf-8 continuation byte 形如 10xxxxxx（高 2 bit = 10）
  // 从 cut 位置往前回退直到下一个字节不是 continuation（即 leading byte 边界）
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut--;
  }
  return buf.subarray(0, cut).toString('utf8') + `\n…[truncated ${buf.length - cut} bytes]`;
}

function shrinkLargeFieldsDeep(value: unknown, depth = 0): unknown {
  if (depth > 3) return value;
  if (Array.isArray(value)) {
    return value.map((v) => shrinkLargeFieldsDeep(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (KNOWN_LARGE_FIELDS.has(k) && typeof v === 'string') {
        out[k] = truncateStringByBytes(v, MAX_FIELD_BYTES);
      } else if (KNOWN_LARGE_FIELDS.has(k) && Array.isArray(v)) {
        // toolResult 在 claude-code 是 block 数组：
        // - 简单形态：[{ type:'text', text:'...' }, ...] → 直接截 text
        // - 嵌套形态：[{ type:'tool_result', content:[{type:'text', text:'...'}] }, ...]
        //   → 必须递归 element 让下层 KNOWN_LARGE 命中 content / text，否则外层逃逸
        out[k] = v.map((el) => {
          if (el && typeof el === 'object') {
            const eo = el as Record<string, unknown>;
            if (typeof eo.text === 'string') {
              return { ...eo, text: truncateStringByBytes(eo.text, MAX_FIELD_BYTES) };
            }
            // 嵌套对象 → 递归（depth +1 进 KNOWN_LARGE 数组算一层）
            return shrinkLargeFieldsDeep(el, depth + 1);
          }
          return el;
        });
      } else if (typeof v === 'object' && v !== null) {
        out[k] = shrinkLargeFieldsDeep(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return value;
}

export function safeStringifyPayload(payload: unknown): string {
  // 总是 shrink 已知大字段（即使整体 < 256KB）：
  // 单字段 8KB 是「显示足够用 + 节省 DB 空间」的实用阈值，超过部分对 UI 可读性几乎无增益，
  // 对长会话 DB 体积是巨大负担。
  const shrunk = shrinkLargeFieldsDeep(payload);
  const raw = JSON.stringify(shrunk ?? null);
  // 注意：这里也得用 byteLength —— 一个 256KB 的中文 payload `raw.length` 可能只有 ~85K
  // 但实际 utf-8 字节是 256K+ 一调 SQLite 写就接近上限。
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes <= MAX_PAYLOAD_BYTES) return raw;

  // 仍 > 256KB（罕见：大量小字段 / 数组爆炸 / 非 KNOWN_LARGE 字段超大）→ 降级为 marker payload，
  // UI 看到 __truncated 标记而非默默丢失，保 SQL 写得下。
  const keys =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload as object).slice(0, 10)
      : [];
  return JSON.stringify({
    __truncated: true,
    __originalBytes: rawBytes,
    __reason: 'payload exceeds 256KB cap even after large-field shrink',
    __keys: keys,
    // preview 也走 utf-8 安全切，避免 marker payload 自己包含孤儿字节
    __preview: truncateStringByBytes(raw, 4096),
  });
}

/** file_changes 的 before_blob / after_blob 已是 string（text diff 原文 / image dataURL 等），单独截。
 *  注意：image dataURL / base64 编码的内容尾切后无法再被 base64 解码 —— 这是当前阈值 256KB 的
 *  设计取舍（截就截）。如未来要支持完整大 blob，得改阈值或拆 chunk 存。 */
export function safeTruncateBlob(blob: string | null | undefined): string | null {
  if (blob == null) return null;
  const bytes = Buffer.byteLength(blob, 'utf8');
  if (bytes <= MAX_PAYLOAD_BYTES) return blob;
  return truncateStringByBytes(blob, MAX_PAYLOAD_BYTES);
}

/** 暴露阈值给测试 / 诊断 / 可观测性。 */
export const PAYLOAD_LIMITS = {
  MAX_PAYLOAD_BYTES,
  MAX_FIELD_BYTES,
} as const;
