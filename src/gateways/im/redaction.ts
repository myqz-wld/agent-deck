import { isSensitiveJsonKey, type JsonObject, type JsonValue } from '@contracts/index';

const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:gh[pousr]|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,})/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

export interface RedactionLimits {
  maxDepth: number;
  maxEntries: number;
  maxStringBytes: number;
}

export const DEFAULT_REDACTION_LIMITS: RedactionLimits = Object.freeze({
  maxDepth: 6,
  maxEntries: 128,
  maxStringBytes: 2_048,
});

export function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const suffix = maximumBytes > 3 ? '...' : '';
  let end = maximumBytes - suffix.length;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return `${decoder.decode(encoded.slice(0, end))}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffix.slice(0, maximumBytes);
}

function cleanString(value: string, maximumBytes: number): string {
  if (SECRET_VALUE.test(value)) return '[REDACTED]';
  return truncateUtf8(value.replace(CONTROL, '�'), maximumBytes);
}

export function redactJson(
  value: JsonValue,
  limits: RedactionLimits = DEFAULT_REDACTION_LIMITS,
): JsonValue {
  let entries = 0;
  const visit = (input: JsonValue, depth: number): JsonValue => {
    if (depth > limits.maxDepth) return '[TRUNCATED]';
    if (typeof input === 'string') return cleanString(input, limits.maxStringBytes);
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (Array.isArray(input)) {
      const result: JsonValue[] = [];
      for (const item of input) {
        if (entries >= limits.maxEntries) {
          result.push('[TRUNCATED]');
          break;
        }
        entries += 1;
        result.push(visit(item, depth + 1));
      }
      return result;
    }
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(input)) {
      if (entries >= limits.maxEntries) {
        output.__truncated__ = true;
        break;
      }
      entries += 1;
      const safeKey = cleanString(key, 128);
      output[safeKey] = isSensitiveJsonKey(key) ? '[REDACTED]' : visit(item, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

export function boundedJsonText(value: JsonValue, maximumBytes: number): string {
  return truncateUtf8(JSON.stringify(redactJson(value)), maximumBytes);
}

export function redactErrorMessage(message: string, maximumBytes = 256): string {
  return cleanString(message, maximumBytes);
}
