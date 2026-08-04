import { FeishuGatewayError } from './errors';
import type { FeishuGatewayLimits } from './types';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function fail(field: string): never {
  throw new FeishuGatewayError(
    'invalid_core_response',
    `Core returned an over-limit or malformed ${field}`,
  );
}

export function assertBoundedCoreValue(
  value: unknown,
  limits: FeishuGatewayLimits,
  field: string,
  maximumRootItems?: number,
): void {
  if (
    maximumRootItems !== undefined &&
    (!Array.isArray(value) || value.length > maximumRootItems)
  ) {
    fail(field);
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop() as { value: unknown; depth: number };
    if (current.depth > limits.maxCoreJsonDepth) fail(field);
    const item = current.value;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(field);
      continue;
    }
    if (typeof item === 'string') {
      if (
        new TextEncoder().encode(item).byteLength > limits.maxCoreFieldBytes ||
        CONTROL.test(item)
      ) {
        fail(field);
      }
      continue;
    }
    if (typeof item !== 'object') fail(field);
    if (seen.has(item)) fail(field);
    seen.add(item);
    if (Array.isArray(item)) {
      entries += item.length;
      if (entries > limits.maxCoreJsonEntries) fail(field);
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) fail(field);
    const objectEntries = Object.entries(item as Record<string, unknown>);
    entries += objectEntries.length;
    if (entries > limits.maxCoreJsonEntries) fail(field);
    for (const [key, child] of objectEntries) {
      if (
        key.length === 0 ||
        new TextEncoder().encode(key).byteLength > 128 ||
        CONTROL.test(key)
      ) {
        fail(field);
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(field);
  }
  if (new TextEncoder().encode(encoded).byteLength > limits.maxCoreResponseBytes) fail(field);
}
