import {
  REDACTED_VALUE,
  safeDiagnosticString as safeString,
} from '@core/safe-diagnostic-text';

export { REDACTED_VALUE, safeDisplayText } from '@core/safe-diagnostic-text';

type SafeDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | SafeDiagnosticValue[]
  | { [key: string]: SafeDiagnosticValue };

interface DiagnosticLimits {
  maxStringLength: number;
  maxStackLength: number;
  maxDepth: number;
  maxKeys: number;
  maxArrayLength: number;
}

interface LogHookMessage {
  data: unknown[];
  [key: string]: unknown;
}

type DiagnosticLogHook = (
  message: LogHookMessage,
  transport: unknown,
  transportName?: string,
) => LogHookMessage | false;

const PERSISTED_LIMITS: DiagnosticLimits = {
  maxStringLength: 512,
  maxStackLength: 2_048,
  maxDepth: 4,
  maxKeys: 24,
  maxArrayLength: 12,
};

const DEVELOPMENT_CONSOLE_LIMITS: DiagnosticLimits = {
  maxStringLength: 2_048,
  maxStackLength: 4_096,
  maxDepth: 5,
  maxKeys: 40,
  maxArrayLength: 20,
};

const installedHooks = new WeakMap<object, DiagnosticLogHook>();

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return /(?:authorization|authentication|credential|password|passwd|cookie|secret|privatekey|signingkey|apikey|accesskey|cardnumber|creditcard|cvv|ssn)$/.test(
    normalized,
  ) || /token$/.test(normalized) || normalized === 'auth';
}

function isExternalContentKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return /(?:prompt|input|payload|rawresult|rawresponse|rawoutput|providertext)$/.test(
    normalized,
  );
}

function valueType(value: unknown): string {
  try {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  } catch {
    return 'uninspectable';
  }
}

function readErrorField(error: Error, key: 'name' | 'message' | 'stack' | 'cause'): unknown {
  try {
    return error[key];
  } catch {
    return undefined;
  }
}

function serializeError(
  error: Error,
  limits: DiagnosticLimits,
  seen: WeakSet<object>,
  depth: number,
): SafeDiagnosticValue {
  if (seen.has(error)) return '[Circular]';
  seen.add(error);
  const output: Record<string, SafeDiagnosticValue> = {
    name: safeString(String(readErrorField(error, 'name') ?? 'Error'), 80),
    message: safeString(String(readErrorField(error, 'message') ?? ''), limits.maxStringLength),
  };
  const stack = readErrorField(error, 'stack');
  if (typeof stack === 'string' && stack) {
    output.stack = safeString(stack, limits.maxStackLength);
  }
  const errorWithCode = error as Error & { code?: unknown };
  try {
    if (typeof errorWithCode.code === 'string' || typeof errorWithCode.code === 'number') {
      output.code = safeString(String(errorWithCode.code), 80);
    }
  } catch {
    // A hostile getter must not make diagnostic serialization throw.
  }
  const cause = readErrorField(error, 'cause');
  if (cause !== undefined) {
    output.cause = serializeValue(cause, limits, seen, depth + 1);
  }
  let keys: string[] = [];
  try {
    keys = Object.keys(error).filter(
      (key) => !['name', 'message', 'stack', 'code', 'cause'].includes(key),
    );
  } catch {
    return output;
  }
  appendObjectEntries(output, error as unknown as Record<string, unknown>, keys, limits, seen, depth);
  return output;
}

function appendObjectEntries(
  output: Record<string, SafeDiagnosticValue>,
  source: Record<string, unknown>,
  keys: string[],
  limits: DiagnosticLimits,
  seen: WeakSet<object>,
  depth: number,
): void {
  const selected = keys.slice(0, limits.maxKeys);
  for (const key of selected) {
    const safeKey = safeString(key, 80);
    if (isSensitiveKey(key) || isExternalContentKey(key)) {
      output[safeKey] = REDACTED_VALUE;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor && !('value' in descriptor)) {
      output[safeKey] = '[Accessor]';
      continue;
    }
    try {
      output[safeKey] = serializeValue(source[key], limits, seen, depth + 1);
    } catch {
      output[safeKey] = '[Unserializable]';
    }
  }
  if (keys.length > selected.length) {
    output.__truncatedKeys = keys.length - selected.length;
  }
}

function serializeValue(
  value: unknown,
  limits: DiagnosticLimits,
  seen: WeakSet<object>,
  depth: number,
): SafeDiagnosticValue {
  if (value === null) return null;
  if (typeof value === 'string') return safeString(value, limits.maxStringLength);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol') return safeString(String(value), 80);
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${safeString(value.name, 80)}` : ''}]`;
  }
  if (depth >= limits.maxDepth) return '[MaxDepth]';
  if (value instanceof Error) return serializeError(value, limits, seen, depth);
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    const selected = value.slice(0, limits.maxArrayLength).map(
      (item) => serializeValue(item, limits, seen, depth + 1),
    );
    if (value.length > selected.length) {
      selected.push(`[TruncatedItems:${value.length - selected.length}]`);
    }
    return selected;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[InvalidDate]' : value.toISOString();
  }
  const output: Record<string, SafeDiagnosticValue> = {};
  let keys: string[];
  try {
    keys = Object.keys(value as object);
  } catch {
    return `[Unserializable:${valueType(value)}]`;
  }
  appendObjectEntries(
    output,
    value as Record<string, unknown>,
    keys,
    limits,
    seen,
    depth,
  );
  return output;
}

export function safeDiagnostic(value: unknown): SafeDiagnosticValue {
  try {
    return serializeValue(value, PERSISTED_LIMITS, new WeakSet<object>(), 0);
  } catch {
    return '[DiagnosticSerializationFailed]';
  }
}

export interface SafeErrorDetails {
  name: string;
  message: string;
  stack?: string;
}

export function toSafeErrorDetails(value: unknown): SafeErrorDetails {
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    return { name: 'Error', message: 'Non-Error rejection (uninspectable)' };
  }
  if (isError) {
    const error = value as Error;
    const name = safeString(String(readErrorField(error, 'name') ?? 'Error'), 80);
    const message = safeString(
      String(readErrorField(error, 'message') ?? 'Unknown error'),
      PERSISTED_LIMITS.maxStringLength,
    );
    const stack = readErrorField(error, 'stack');
    return {
      name,
      message,
      ...(typeof stack === 'string' && stack
        ? { stack: safeString(stack, PERSISTED_LIMITS.maxStackLength) }
        : {}),
    };
  }
  if (typeof value === 'string') {
    return { name: 'Error', message: safeString(value, PERSISTED_LIMITS.maxStringLength) };
  }
  return {
    name: 'Error',
    message: `Non-Error rejection (${valueType(value)})`,
  };
}

export function safeErrorSummary(value: unknown): Record<string, SafeDiagnosticValue> {
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    return { type: 'uninspectable' };
  }
  if (!isError) {
    return { type: valueType(value) };
  }
  const error = value as Error;
  const message = readErrorField(error, 'message');
  const stack = readErrorField(error, 'stack');
  const errorWithCode = error as Error & { code?: unknown };
  let code: SafeDiagnosticValue | undefined;
  try {
    if (typeof errorWithCode.code === 'string' || typeof errorWithCode.code === 'number') {
      code = safeString(String(errorWithCode.code), 80);
    }
  } catch {
    code = undefined;
  }
  return {
    type: 'error',
    name: safeString(String(readErrorField(error, 'name') ?? 'Error'), 80),
    messageLength: typeof message === 'string' ? message.length : 0,
    hasStack: typeof stack === 'string' && stack.length > 0,
    ...(code !== undefined ? { code } : {}),
  };
}

export function installSafeDiagnosticLogHook(
  logger: { hooks: unknown[] },
  options: { developmentConsoleDetail: boolean },
): DiagnosticLogHook {
  const loggerObject = logger as object;
  const existing = installedHooks.get(loggerObject);
  if (existing) {
    if (!logger.hooks.includes(existing)) logger.hooks.push(existing);
    return existing;
  }
  const hook: DiagnosticLogHook = (message, _transport, transportName) => {
    const limits = transportName === 'console' && options.developmentConsoleDetail
      ? DEVELOPMENT_CONSOLE_LIMITS
      : PERSISTED_LIMITS;
    try {
      return {
        ...message,
        data: message.data.map(
          (item) => serializeValue(item, limits, new WeakSet<object>(), 0),
        ),
      };
    } catch {
      return { ...message, data: ['[DiagnosticSerializationFailed]'] };
    }
  };
  installedHooks.set(loggerObject, hook);
  logger.hooks.push(hook);
  return hook;
}
