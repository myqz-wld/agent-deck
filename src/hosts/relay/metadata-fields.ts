const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const STABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;

export class RelayMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayMetadataError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(
  row: Record<string, unknown>,
  field: string,
  maximumBytes = 512,
): string {
  const value = row[field];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new RelayMetadataError(`${field} must be a bounded non-empty UTF-8 string`);
  }
  if (FORBIDDEN_TEXT.test(value)) {
    throw new RelayMetadataError(`${field} contains forbidden control characters`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    throw new RelayMetadataError(`${field} cannot contain private key material`);
  }
  return value;
}

export function stableTokenField(
  row: Record<string, unknown>,
  field: string,
  maximumBytes = 512,
): string {
  const value = stringField(row, field, maximumBytes);
  if (!STABLE_TOKEN.test(value)) {
    throw new RelayMetadataError(`${field} must use stable token syntax`);
  }
  return value;
}

export function nullableStringField(
  row: Record<string, unknown>,
  field: string,
  maximumBytes = 512,
): string | null {
  return row[field] === null ? null : stringField(row, field, maximumBytes);
}

export function nullableStableTokenField(
  row: Record<string, unknown>,
  field: string,
  maximumBytes = 512,
): string | null {
  return row[field] === null ? null : stableTokenField(row, field, maximumBytes);
}

export function integerField(
  row: Record<string, unknown>,
  field: string,
  minimum = 0,
): number {
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RelayMetadataError(`${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

export function enumField<T extends string>(
  row: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = row[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RelayMetadataError(`${field} is not an allowed value`);
  }
  return value as T;
}
