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

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
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
        out[k] = truncateString(v, MAX_FIELD_BYTES);
      } else if (KNOWN_LARGE_FIELDS.has(k) && Array.isArray(v)) {
        // toolResult 在 claude-code 是 block 数组，element 多是 { type, text }
        out[k] = v.map((el) => {
          if (el && typeof el === 'object') {
            const eo = el as Record<string, unknown>;
            if (typeof eo.text === 'string') {
              return { ...eo, text: truncateString(eo.text, MAX_FIELD_BYTES) };
            }
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
  // 对长会话 DB 体积是巨大负担。typecheck/test 已覆盖：8KB+5KB 的单 toolResult 字段必须被截。
  const shrunk = shrinkLargeFieldsDeep(payload);
  const raw = JSON.stringify(shrunk ?? null);
  if (raw.length <= MAX_PAYLOAD_BYTES) return raw;

  // 仍 > 256KB（罕见：大量小字段 / 数组爆炸 / 非 KNOWN_LARGE 字段超大）→ 降级为 marker payload，
  // UI 看到 __truncated 标记而非默默丢失，保 SQL 写得下。
  const keys =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload as object).slice(0, 10)
      : [];
  return JSON.stringify({
    __truncated: true,
    __originalBytes: raw.length,
    __reason: 'payload exceeds 256KB cap even after large-field shrink',
    __keys: keys,
    __preview: raw.slice(0, 4096) + '…[TRUNCATED]',
  });
}

/** file_changes 的 before_blob / after_blob 已是 string（text diff 原文 / image dataURL 等），单独截。 */
export function safeTruncateBlob(blob: string | null | undefined): string | null {
  if (blob == null) return null;
  if (blob.length <= MAX_PAYLOAD_BYTES) return blob;
  return blob.slice(0, MAX_PAYLOAD_BYTES) + `\n…[truncated ${blob.length - MAX_PAYLOAD_BYTES} chars]`;
}

/** 暴露阈值给测试 / 诊断 / 可观测性。 */
export const PAYLOAD_LIMITS = {
  MAX_PAYLOAD_BYTES,
  MAX_FIELD_BYTES,
} as const;
