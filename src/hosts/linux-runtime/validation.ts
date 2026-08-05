import { isAbsolute, normalize } from 'node:path';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const LINUX_INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function requireStableToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new Error(`${field} must be a stable token`);
  }
  return value;
}

/** Exact Linux instance label: lowercase ASCII, 1-63 bytes, no edge hyphen. */
export function requireLinuxInstanceId(value: unknown, field = 'instanceId'): string {
  if (typeof value !== 'string' || !LINUX_INSTANCE_ID.test(value)) {
    throw new Error(`${field} must be a lowercase Linux instance label`);
  }
  return value;
}

export function requireAbsolutePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value === '/'
  ) {
    throw new Error(`${field} must be a normalized non-root absolute path`);
  }
  return value;
}

export function requirePositiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${field} must be a bounded positive integer`);
  }
  return value as number;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${field} has missing or extra fields`);
  }
}

export function parseExactFlags(
  argv: readonly string[],
  allowed: readonly string[],
): Readonly<Record<string, string>> {
  if (argv.length % 2 !== 0) throw new Error('command flags must have values');
  const permitted = new Set(allowed);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!permitted.has(flag) || Object.prototype.hasOwnProperty.call(parsed, flag)) {
      throw new Error('command contains an unknown or duplicate flag');
    }
    if (!value || value.includes('\0') || value.startsWith('--')) {
      throw new Error('command flag value is invalid');
    }
    parsed[flag] = value;
  }
  for (const flag of allowed) {
    if (!Object.prototype.hasOwnProperty.call(parsed, flag)) {
      throw new Error(`command requires ${flag}`);
    }
  }
  return Object.freeze(parsed);
}
