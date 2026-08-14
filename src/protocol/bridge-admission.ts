const ADMISSION_PREFIX_BYTES = 4;
const ADMISSION_VERSION = 2;
const DEFAULT_MAX_ADMISSION_BYTES = 8 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;

export type BridgeClientSurface = 'desktop' | 'feishu';

export type BridgeAdmission =
  | {
      version: 2;
      topology: 'full' | 'relay';
      role: 'client';
      instanceId: string;
      credentialId: string;
      connectionScope: string;
      surface: BridgeClientSurface;
    }
  | {
      version: 2;
      topology: 'relay';
      role: 'worker';
      instanceId: string;
      credentialId: string;
      workerId: string;
    };

export type BridgeClientAdmission = Extract<BridgeAdmission, { role: 'client' }>;
export type BridgeWorkerAdmission = Extract<BridgeAdmission, { role: 'worker' }>;

export interface DecodedBridgeAdmission {
  admission: BridgeAdmission;
  remainder: Uint8Array;
}

export class BridgeAdmissionError extends Error {
  constructor(
    readonly code: 'admission_invalid' | 'admission_oversized' | 'admission_state',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeAdmissionError';
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxAdmissionBytes must be a positive safe integer');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireToken(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 160 ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw new BridgeAdmissionError(
      'admission_invalid',
      `${field} must be a 1-160 byte bridge token`,
    );
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new BridgeAdmissionError('admission_invalid', `Unknown admission field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new BridgeAdmissionError('admission_invalid', `Missing admission field: ${key}`);
    }
  }
}

export function assertBridgeAdmission(value: unknown): asserts value is BridgeAdmission {
  if (!isRecord(value)) {
    throw new BridgeAdmissionError('admission_invalid', 'Bridge admission must be an object');
  }
  if (value.version !== ADMISSION_VERSION) {
    throw new BridgeAdmissionError('admission_invalid', 'Unsupported bridge admission version');
  }
  if (value.role !== 'client' && value.role !== 'worker') {
    throw new BridgeAdmissionError('admission_invalid', 'Bridge admission role is invalid');
  }
  if (value.role === 'client') {
    assertExactKeys(value, [
      'version',
      'topology',
      'role',
      'instanceId',
      'credentialId',
      'connectionScope',
      'surface',
    ]);
    if (value.topology !== 'full' && value.topology !== 'relay') {
      throw new BridgeAdmissionError('admission_invalid', 'Client admission topology is invalid');
    }
    if (value.surface !== 'desktop' && value.surface !== 'feishu') {
      throw new BridgeAdmissionError('admission_invalid', 'Client admission surface is invalid');
    }
    requireToken(value.connectionScope, 'connectionScope');
  } else {
    assertExactKeys(value, [
      'version',
      'topology',
      'role',
      'instanceId',
      'credentialId',
      'workerId',
    ]);
    if (value.topology !== 'relay') {
      throw new BridgeAdmissionError('admission_invalid', 'Worker admission requires Relay');
    }
    requireToken(value.workerId, 'workerId');
  }
  requireToken(value.instanceId, 'instanceId');
  requireToken(value.credentialId, 'credentialId');
}

function decodeAdmission(payload: Uint8Array): BridgeAdmission {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new BridgeAdmissionError('admission_invalid', 'Bridge admission is not valid JSON');
  }
  assertBridgeAdmission(decoded);
  return decoded;
}

export function encodeBridgeAdmission(
  admission: BridgeAdmission,
  maxAdmissionBytes = DEFAULT_MAX_ADMISSION_BYTES,
): Uint8Array {
  assertBridgeAdmission(admission);
  const limit = assertLimit(maxAdmissionBytes);
  const payload = new TextEncoder().encode(JSON.stringify(admission));
  if (payload.byteLength === 0 || payload.byteLength > limit) {
    throw new BridgeAdmissionError('admission_oversized', 'Bridge admission exceeds its limit');
  }
  const encoded = new Uint8Array(ADMISSION_PREFIX_BYTES + payload.byteLength);
  new DataView(encoded.buffer).setUint32(0, payload.byteLength, false);
  encoded.set(payload, ADMISSION_PREFIX_BYTES);
  return encoded;
}

/** Parses exactly one admission frame and returns any coalesced transport bytes untouched. */
export class BridgeAdmissionDecoder {
  private readonly prefix = new Uint8Array(ADMISSION_PREFIX_BYTES);
  private prefixBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;
  private completed = false;
  readonly maxAdmissionBytes: number;

  constructor(maxAdmissionBytes = DEFAULT_MAX_ADMISSION_BYTES) {
    this.maxAdmissionBytes = assertLimit(maxAdmissionBytes);
  }

  get bufferedBytes(): number {
    return this.prefixBytes + this.payloadBytes;
  }

  push(chunk: Uint8Array): DecodedBridgeAdmission | null {
    if (this.completed) {
      throw new BridgeAdmissionError('admission_state', 'Bridge admission is already complete');
    }
    let offset = 0;
    if (this.prefixBytes < ADMISSION_PREFIX_BYTES) {
      const count = Math.min(ADMISSION_PREFIX_BYTES - this.prefixBytes, chunk.byteLength);
      this.prefix.set(chunk.subarray(0, count), this.prefixBytes);
      this.prefixBytes += count;
      offset += count;
      if (this.prefixBytes < ADMISSION_PREFIX_BYTES) return null;
      const declared = new DataView(this.prefix.buffer).getUint32(0, false);
      if (declared === 0 || declared > this.maxAdmissionBytes) {
        throw new BridgeAdmissionError(
          'admission_oversized',
          `Bridge admission declares invalid size ${declared}`,
        );
      }
      this.payload = new Uint8Array(declared);
    }
    const payload = this.payload;
    if (!payload) throw new BridgeAdmissionError('admission_state', 'Admission payload missing');
    const count = Math.min(payload.byteLength - this.payloadBytes, chunk.byteLength - offset);
    payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
    this.payloadBytes += count;
    offset += count;
    if (this.payloadBytes < payload.byteLength) return null;
    this.completed = true;
    return {
      admission: decodeAdmission(payload),
      remainder: chunk.slice(offset),
    };
  }
}
