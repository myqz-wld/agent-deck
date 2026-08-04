import {
  decodeRelayRouteFrame,
  encodeRelayRouteFrame,
  type RelayRouteFrame,
  type RelayRouteFrameLimits,
} from './route-frame';

const WIRE_PREFIX_BYTES = 4;
const WIRE_TYPE_BYTES = 1;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;

const WireType = {
  Attach: 1,
  Attached: 2,
  Rejected: 3,
  Route: 4,
} as const;

export type WorkerAttachMode = 'register' | 'reconnect' | 'takeover';

export interface WorkerAttachRequest {
  type: 'attach';
  instanceId: string;
  workerId: string;
  credentialId: string;
  mode: WorkerAttachMode;
  generation: number | null;
  expectedGeneration: number | null;
}

export interface WorkerAttached {
  type: 'attached';
  instanceId: string;
  workerId: string;
  generation: number;
  heartbeatTimeoutMs: number;
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxFrameBytes: number;
}

export interface WorkerNegotiatedRouteLimits {
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxFrameBytes: number;
}

export interface WorkerAttachRejected {
  type: 'rejected';
  code:
    | 'credential_mismatch'
    | 'generation_conflict'
    | 'invalid_attach'
    | 'worker_already_registered'
    | 'worker_not_registered';
  message: string;
  retryable: boolean;
  currentGeneration: number | null;
}

export interface WorkerRouteMessage {
  type: 'route';
  frame: RelayRouteFrame;
}

export type WorkerWireMessage =
  | WorkerAttachRequest
  | WorkerAttached
  | WorkerAttachRejected
  | WorkerRouteMessage;

export class WorkerWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerWireError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    throw new WorkerWireError(`${field} must be a bounded non-empty UTF-8 string`);
  }
  if (FORBIDDEN_TEXT.test(value)) throw new WorkerWireError(`${field} contains control characters`);
  return value;
}

function requireIdentity(value: unknown, field: string): string {
  const token = requireText(value, field);
  if (!IDENTITY_TOKEN.test(token)) throw new WorkerWireError(`${field} has invalid token syntax`);
  return token;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new WorkerWireError(`${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function requireNullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : requireInteger(value, field);
}

function parseJson(payload: Uint8Array): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch (error) {
    throw new WorkerWireError(
      error instanceof Error ? error.message : 'Worker attachment message is invalid JSON',
    );
  }
  if (!isRecord(decoded)) throw new WorkerWireError('Worker attachment message must be an object');
  return decoded;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new WorkerWireError(`Unknown worker attachment field: ${key}`);
  }
}

function parseAttach(value: Record<string, unknown>): WorkerAttachRequest {
  assertOnlyKeys(value, [
    'type',
    'instanceId',
    'workerId',
    'credentialId',
    'mode',
    'generation',
    'expectedGeneration',
  ]);
  if (value.type !== 'attach') throw new WorkerWireError('Invalid attach message type');
  if (value.mode !== 'register' && value.mode !== 'reconnect' && value.mode !== 'takeover') {
    throw new WorkerWireError('Invalid worker attach mode');
  }
  const request: WorkerAttachRequest = {
    type: 'attach',
    instanceId: requireIdentity(value.instanceId, 'instanceId'),
    workerId: requireIdentity(value.workerId, 'workerId'),
    credentialId: requireIdentity(value.credentialId, 'credentialId'),
    mode: value.mode,
    generation: requireNullableInteger(value.generation, 'generation'),
    expectedGeneration: requireNullableInteger(
      value.expectedGeneration,
      'expectedGeneration',
    ),
  };
  if (request.mode === 'register') {
    if (request.generation !== null || request.expectedGeneration !== null) {
      throw new WorkerWireError('register requires null generation fields');
    }
  } else if (request.mode === 'reconnect') {
    if (
      request.generation === null ||
      request.generation < 1 ||
      request.expectedGeneration !== null
    ) {
      throw new WorkerWireError('reconnect requires generation and null expectedGeneration');
    }
  } else if (
    request.generation !== null ||
    request.expectedGeneration === null ||
    request.expectedGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    throw new WorkerWireError('takeover requires null generation and a safe successor');
  }
  return request;
}

function parseAttached(value: Record<string, unknown>): WorkerAttached {
  assertOnlyKeys(value, [
    'type',
    'instanceId',
    'workerId',
    'generation',
    'heartbeatTimeoutMs',
    'initialCreditBytes',
    'maxCreditBytes',
    'maxFrameBytes',
  ]);
  if (value.type !== 'attached') throw new WorkerWireError('Invalid attached message type');
  const attached: WorkerAttached = {
    type: 'attached',
    instanceId: requireIdentity(value.instanceId, 'instanceId'),
    workerId: requireIdentity(value.workerId, 'workerId'),
    generation: requireInteger(value.generation, 'generation', 1),
    heartbeatTimeoutMs: requireInteger(value.heartbeatTimeoutMs, 'heartbeatTimeoutMs', 1),
    initialCreditBytes: requireInteger(value.initialCreditBytes, 'initialCreditBytes', 1),
    maxCreditBytes: requireInteger(value.maxCreditBytes, 'maxCreditBytes', 1),
    maxFrameBytes: requireInteger(value.maxFrameBytes, 'maxFrameBytes', 1),
  };
  if (attached.initialCreditBytes > attached.maxCreditBytes) {
    throw new WorkerWireError('initialCreditBytes cannot exceed maxCreditBytes');
  }
  return attached;
}

export function workerAttachedRouteLimits(
  attached: WorkerAttached,
): WorkerNegotiatedRouteLimits {
  return {
    initialCreditBytes: attached.initialCreditBytes,
    maxCreditBytes: attached.maxCreditBytes,
    maxFrameBytes: attached.maxFrameBytes,
  };
}

function parseRejected(value: Record<string, unknown>): WorkerAttachRejected {
  assertOnlyKeys(value, [
    'type',
    'code',
    'message',
    'retryable',
    'currentGeneration',
  ]);
  const codes = new Set<WorkerAttachRejected['code']>([
    'credential_mismatch',
    'generation_conflict',
    'invalid_attach',
    'worker_already_registered',
    'worker_not_registered',
  ]);
  if (value.type !== 'rejected' || !codes.has(value.code as WorkerAttachRejected['code'])) {
    throw new WorkerWireError('Invalid rejected message');
  }
  if (typeof value.retryable !== 'boolean') {
    throw new WorkerWireError('retryable must be boolean');
  }
  return {
    type: 'rejected',
    code: value.code as WorkerAttachRejected['code'],
    message: requireText(value.message, 'message'),
    retryable: value.retryable,
    currentGeneration: requireNullableInteger(value.currentGeneration, 'currentGeneration'),
  };
}

function encodeJson(value: WorkerAttachRequest | WorkerAttached | WorkerAttachRejected): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function bodyFor(message: WorkerWireMessage, routeLimits: RelayRouteFrameLimits): Uint8Array {
  let type: number;
  let payload: Uint8Array;
  if (message.type === 'route') {
    type = WireType.Route;
    payload = encodeRelayRouteFrame(message.frame, routeLimits);
  } else {
    type =
      message.type === 'attach'
        ? WireType.Attach
        : message.type === 'attached'
          ? WireType.Attached
          : WireType.Rejected;
    payload = encodeJson(message);
  }
  const body = new Uint8Array(WIRE_TYPE_BYTES + payload.byteLength);
  body[0] = type;
  body.set(payload, WIRE_TYPE_BYTES);
  return body;
}

export function encodeWorkerWireMessage(
  message: WorkerWireMessage,
  routeLimits: RelayRouteFrameLimits = {},
): Uint8Array {
  const body = bodyFor(message, routeLimits);
  const encoded = new Uint8Array(WIRE_PREFIX_BYTES + body.byteLength);
  new DataView(encoded.buffer).setUint32(0, body.byteLength, false);
  encoded.set(body, WIRE_PREFIX_BYTES);
  return encoded;
}

export function workerWireMessageBytes(
  message: WorkerWireMessage,
  routeLimits: RelayRouteFrameLimits = {},
): number {
  return encodeWorkerWireMessage(message, routeLimits).byteLength;
}

function decodeBody(body: Uint8Array, routeLimits: RelayRouteFrameLimits): WorkerWireMessage {
  if (body.byteLength <= WIRE_TYPE_BYTES) throw new WorkerWireError('Worker wire frame is empty');
  const payload = body.subarray(WIRE_TYPE_BYTES);
  switch (body[0]) {
    case WireType.Attach:
      return parseAttach(parseJson(payload));
    case WireType.Attached:
      return parseAttached(parseJson(payload));
    case WireType.Rejected:
      return parseRejected(parseJson(payload));
    case WireType.Route:
      return { type: 'route', frame: decodeRelayRouteFrame(payload, routeLimits) };
    default:
      throw new WorkerWireError(`Unknown worker wire message type: ${String(body[0])}`);
  }
}

export class WorkerWireDecoder {
  private partial = new Uint8Array(0);
  private partialBytes = 0;
  private partialTotalBytes = 0;

  constructor(
    readonly maxWireBytes = 8 * 1024 * 1024,
    private routeLimits: RelayRouteFrameLimits = {},
  ) {
    if (!Number.isSafeInteger(maxWireBytes) || maxWireBytes <= 0) {
      throw new RangeError('maxWireBytes must be a positive safe integer');
    }
  }

  get bufferedBytes(): number {
    return this.partialBytes;
  }

  setRouteLimits(routeLimits: RelayRouteFrameLimits): void {
    this.routeLimits = { ...routeLimits };
  }

  push(chunk: Uint8Array): WorkerWireMessage[] {
    const messages: WorkerWireMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.partialBytes > 0) {
        if (this.partialBytes < WIRE_PREFIX_BYTES) {
          const prefixBytes = Math.min(
            WIRE_PREFIX_BYTES - this.partialBytes,
            chunk.byteLength - offset,
          );
          this.partial.set(chunk.subarray(offset, offset + prefixBytes), this.partialBytes);
          this.partialBytes += prefixBytes;
          offset += prefixBytes;
          if (this.partialBytes < WIRE_PREFIX_BYTES) break;
          this.allocatePartialBody();
        }
        const bodyBytes = Math.min(
          this.partialTotalBytes - this.partialBytes,
          chunk.byteLength - offset,
        );
        this.partial.set(chunk.subarray(offset, offset + bodyBytes), this.partialBytes);
        this.partialBytes += bodyBytes;
        offset += bodyBytes;
        if (this.partialBytes === this.partialTotalBytes) {
          const body = this.partial.subarray(WIRE_PREFIX_BYTES);
          this.reset();
          messages.push(decodeBody(body, this.routeLimits));
        }
        continue;
      }
      const remaining = chunk.byteLength - offset;
      if (remaining < WIRE_PREFIX_BYTES) {
        this.partial = new Uint8Array(WIRE_PREFIX_BYTES);
        this.partial.set(chunk.subarray(offset));
        this.partialBytes = remaining;
        break;
      }
      const bodyBytes = this.declaredBodyBytes(chunk, offset);
      const totalBytes = WIRE_PREFIX_BYTES + bodyBytes;
      if (remaining >= totalBytes) {
        messages.push(
          decodeBody(
            chunk.subarray(offset + WIRE_PREFIX_BYTES, offset + totalBytes),
            this.routeLimits,
          ),
        );
        offset += totalBytes;
      } else {
        this.partial = new Uint8Array(totalBytes);
        this.partial.set(chunk.subarray(offset));
        this.partialBytes = remaining;
        this.partialTotalBytes = totalBytes;
        break;
      }
    }
    return messages;
  }

  private reset(): void {
    this.partial = new Uint8Array(0);
    this.partialBytes = 0;
    this.partialTotalBytes = 0;
  }

  private declaredBodyBytes(source: Uint8Array, offset: number): number {
    const bodyBytes = new DataView(
      source.buffer,
      source.byteOffset + offset,
      WIRE_PREFIX_BYTES,
    ).getUint32(0, false);
    if (bodyBytes === 0 || bodyBytes > this.maxWireBytes) {
      this.reset();
      throw new WorkerWireError(`Worker wire frame declares invalid size ${bodyBytes}`);
    }
    return bodyBytes;
  }

  private allocatePartialBody(): void {
    const bodyBytes = this.declaredBodyBytes(this.partial, 0);
    const next = new Uint8Array(WIRE_PREFIX_BYTES + bodyBytes);
    next.set(this.partial.subarray(0, WIRE_PREFIX_BYTES));
    this.partial = next;
    this.partialTotalBytes = next.byteLength;
  }
}
