export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export const SSH_TEXT_LIMITS = Object.freeze({
  profileId: 128,
  profileLabel: 256,
  clientId: 128,
  instanceId: 128,
  coreId: 128,
  requestId: 256,
  idempotencyKey: 512,
  hostname: 253,
  username: 128,
  path: 4_096,
});

const FORBIDDEN_WIRE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function hasForbiddenWireControl(value: string): boolean {
  return FORBIDDEN_WIRE_TEXT.test(value);
}

export function isBoundedSingleLine(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    !hasForbiddenWireControl(value)
  );
}

export function assertBoundedSingleLine(
  value: string,
  field: string,
  maxBytes: number,
): void {
  if (!isBoundedSingleLine(value, maxBytes)) {
    throw new Error(
      `${field} must be non-empty, free of wire control characters, and at most ${maxBytes} UTF-8 bytes`,
    );
  }
}
