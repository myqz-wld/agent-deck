import { isJsonObject, type JsonObject, type JsonValue } from './json';

export const PERMISSION_PREVIEW_SCHEMA = 'agent-deck.permission-preview.v1';
export const PERMISSION_PREVIEW_MAX_INPUT_BYTES = 48 * 1024;

const MAX_DEPTH = 8;
const MAX_ENTRIES = 64;
const MAX_NODES = 512;
const MAX_STRING_BYTES = 16 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|passwd|private[-_]?key|secret|token)/iu;
const UTF8 = new TextEncoder();

export function isSensitiveJsonKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export type PermissionPreviewDisplay = JsonObject & {
  schema: typeof PERMISSION_PREVIEW_SCHEMA;
  tool: string;
  input: JsonObject;
  complete: boolean;
  redacted: boolean;
  command?: string;
  description?: string;
};

interface PreviewState {
  complete: boolean;
  redacted: boolean;
  nodes: number;
  remainingBytes: number;
  ancestors: WeakSet<object>;
}

function byteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

function clip(value: string, maximum: number): { value: string; complete: boolean } {
  if (CONTROL.test(value)) return { value: '[content omitted]', complete: false };
  const encoded = UTF8.encode(value);
  if (encoded.byteLength <= maximum) return { value, complete: true };
  const marker = '…[truncated]';
  const markerBytes = byteLength(marker);
  let cut = Math.max(0, maximum - markerBytes);
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return {
    value: `${new TextDecoder().decode(encoded.slice(0, cut))}${marker}`,
    complete: false,
  };
}

function reserveText(value: string, state: PreviewState): string {
  const allowance = Math.max(0, Math.min(MAX_STRING_BYTES, state.remainingBytes));
  const bounded = clip(value, allowance);
  state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(bounded.value));
  if (!bounded.complete) state.complete = false;
  return bounded.value;
}

function unavailable(state: PreviewState, message: string): string {
  state.complete = false;
  return reserveText(message, state);
}

function previewValue(
  value: unknown,
  state: PreviewState,
  depth: number,
  key: string | null,
): JsonValue {
  state.nodes += 1;
  state.remainingBytes = Math.max(0, state.remainingBytes - 4);
  if (state.nodes > MAX_NODES || state.remainingBytes === 0) {
    return unavailable(state, '[preview limit reached]');
  }
  if (key !== null && isSensitiveJsonKey(key)) {
    state.redacted = true;
    return reserveText('[redacted]', state);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : unavailable(state, '[non-finite number]');
  }
  if (typeof value === 'string') return reserveText(value, state);
  if (depth >= MAX_DEPTH) return unavailable(state, '[maximum depth reached]');
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) return unavailable(state, '[circular value]');
    state.ancestors.add(value);
    try {
      if (value.length > MAX_ENTRIES) state.complete = false;
      return value.slice(0, MAX_ENTRIES).map((item) =>
        previewValue(item, state, depth + 1, null));
    } finally {
      state.ancestors.delete(value);
    }
  }
  if (value === null || typeof value !== 'object') {
    return unavailable(state, `[unsupported ${typeof value}]`);
  }
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value) as object | null; }
  catch { return unavailable(state, '[unreadable object]'); }
  if (prototype !== Object.prototype && prototype !== null) {
    return unavailable(state, '[unsupported object]');
  }
  if (state.ancestors.has(value)) return unavailable(state, '[circular value]');
  state.ancestors.add(value);
  try {
    let keys: string[];
    try { keys = Object.keys(value); }
    catch { return unavailable(state, '[unreadable object]'); }
    if (keys.length > MAX_ENTRIES) state.complete = false;
    const result = Object.create(null) as JsonObject;
    for (const keyName of keys.slice(0, MAX_ENTRIES)) {
      if (!keyName || keyName.length > 256 || CONTROL.test(keyName)) {
        state.complete = false;
        continue;
      }
      state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(keyName) - 4);
      let entry: unknown;
      try { entry = (value as Record<string, unknown>)[keyName]; }
      catch { entry = undefined; }
      result[keyName] = previewValue(entry, state, depth + 1, keyName);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function legacyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return clip(value, 4_096).value;
}

export function createPermissionPreviewDisplay(
  toolName: string,
  toolInput: Record<string, unknown>,
): PermissionPreviewDisplay {
  const state: PreviewState = {
    complete: true,
    redacted: false,
    nodes: 0,
    remainingBytes: PERMISSION_PREVIEW_MAX_INPUT_BYTES,
    ancestors: new WeakSet(),
  };
  const candidate = previewValue(toolInput, state, 0, null);
  let input = isJsonObject(candidate) ? candidate : { preview: candidate };
  if (byteLength(JSON.stringify(input)) > PERMISSION_PREVIEW_MAX_INPUT_BYTES) {
    state.complete = false;
    input = { preview: '[authorization input exceeds the remote preview limit]' };
  }
  const tool = clip(toolName, 256);
  if (!tool.complete) state.complete = false;
  const command = legacyText(toolInput.command);
  const description = legacyText(toolInput.description);
  return {
    schema: PERMISSION_PREVIEW_SCHEMA,
    tool: tool.value,
    input,
    complete: state.complete,
    redacted: state.redacted,
    ...(command === undefined ? {} : { command }),
    ...(description === undefined ? {} : { description }),
  };
}

export function parsePermissionPreviewDisplay(
  value: JsonObject,
): PermissionPreviewDisplay | null {
  if (value.schema !== PERMISSION_PREVIEW_SCHEMA) return null;
  const allowed = new Set([
    'command', 'complete', 'description', 'input', 'redacted', 'schema', 'tool',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.tool !== 'string' || value.tool.length === 0 ||
    byteLength(value.tool) > 256 || CONTROL.test(value.tool) ||
    !isJsonObject(value.input) ||
    byteLength(JSON.stringify(value.input)) > PERMISSION_PREVIEW_MAX_INPUT_BYTES ||
    typeof value.complete !== 'boolean' ||
    typeof value.redacted !== 'boolean' ||
    (value.command !== undefined && (
      typeof value.command !== 'string' || byteLength(value.command) > 4_096 ||
      CONTROL.test(value.command)
    )) ||
    (value.description !== undefined && (
      typeof value.description !== 'string' || byteLength(value.description) > 4_096 ||
      CONTROL.test(value.description)
    ))
  ) throw new Error('Invalid permission preview display');
  return value as PermissionPreviewDisplay;
}
