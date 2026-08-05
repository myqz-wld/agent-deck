const ROUTE_PREFIX_BYTES = 4;
const ROUTE_METADATA_LENGTH_BYTES = 4;
const ROUTE_VERSION = 1;
export const RELAY_CONTROL_STREAM_ID = '$lease';
export const DEFAULT_MAX_ROUTE_FRAME_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_ROUTE_CREDIT_BYTES = 4 * 1024 * 1024;
export type RelayDirection = 'client-to-worker' | 'worker-to-client';
export type RelayFrameKind = 'open' | 'data' | 'close' | 'reset' | 'credit' | 'heartbeat';
export type RelayResetCode =
  | 'backpressure'
  | 'cancelled'
  | 'generation_mismatch'
  | 'heartbeat_timeout'
  | 'protocol_error'
  | 'resync_required'
  | 'worker_disconnected'
  | 'worker_fenced'
  | 'worker_offline';
export type RelayClientSurface = 'desktop-full' | 'feishu-session-console';

export interface RelayRouteFrame {
  instanceId: string;
  generation: number;
  streamId: string;
  direction: RelayDirection;
  sequence: number;
  kind: RelayFrameKind;
  payload: Uint8Array;
  creditBytes: number | null;
  resetCode: RelayResetCode | null;
  accessCredentialId: string | null;
  accessSurface: RelayClientSurface | null;
}

export interface RelayRouteFrameLimits {
  maxFrameBytes?: number;
  maxCreditBytes?: number;
}

export type RelayRouteFrameErrorCode =
  | 'frame_invalid'
  | 'frame_oversized'
  | 'frame_truncated'
  | 'frame_unknown_kind';

export class RelayRouteFrameError extends Error {
  constructor(readonly code: RelayRouteFrameErrorCode, message: string) {
    super(message);
    this.name = 'RelayRouteFrameError';
  }
}

interface RouteMetadata {
  version: number;
  instanceId: string;
  generation: number;
  streamId: string;
  direction: RelayDirection;
  sequence: number;
  kind: RelayFrameKind;
  creditBytes: number | null;
  resetCode: RelayResetCode | null;
  accessCredentialId: string | null;
  accessSurface: RelayClientSurface | null;
}

const DIRECTIONS = new Set<RelayDirection>(['client-to-worker', 'worker-to-client']);
const KINDS = new Set<RelayFrameKind>(['open', 'data', 'close', 'reset', 'credit', 'heartbeat']);
const RESET_CODES = new Set<RelayResetCode>([
  'backpressure', 'cancelled', 'generation_mismatch', 'heartbeat_timeout', 'protocol_error',
  'resync_required', 'worker_disconnected', 'worker_fenced', 'worker_offline',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/$-]+$/;
const METADATA_KEYS = new Set([
  'version',
  'instanceId',
  'generation',
  'streamId',
  'direction',
  'sequence',
  'kind',
  'creditBytes',
  'resetCode',
  'accessCredentialId',
  'accessSurface',
]);

function requirePositiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 160 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      `${field} must be a 1-160 character route identifier`,
    );
  }
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertMetadata(value: unknown): asserts value is RouteMetadata {
  if (!isRecord(value)) {
    throw new RelayRouteFrameError('frame_invalid', 'Route metadata must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) {
      throw new RelayRouteFrameError('frame_invalid', `Unknown route metadata field: ${key}`);
    }
  }
  if (value.version !== ROUTE_VERSION) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      `Unsupported route envelope version: ${String(value.version)}`,
    );
  }
  assertIdentifier(value.instanceId, 'instanceId');
  assertSafeInteger(value.generation, 'generation');
  assertIdentifier(value.streamId, 'streamId');
  if (!DIRECTIONS.has(value.direction as RelayDirection)) {
    throw new RelayRouteFrameError('frame_invalid', 'direction is invalid');
  }
  assertSafeInteger(value.sequence, 'sequence');
  if (!KINDS.has(value.kind as RelayFrameKind)) {
    throw new RelayRouteFrameError('frame_unknown_kind', 'kind is invalid');
  }
  if (value.creditBytes !== null) assertSafeInteger(value.creditBytes, 'creditBytes', 1);
  if (value.resetCode !== null && !RESET_CODES.has(value.resetCode as RelayResetCode)) {
    throw new RelayRouteFrameError('frame_invalid', 'resetCode is invalid');
  }
  if (value.accessCredentialId !== null) {
    assertIdentifier(value.accessCredentialId, 'accessCredentialId');
  }
  if (
    value.accessSurface !== null &&
    value.accessSurface !== 'desktop-full' &&
    value.accessSurface !== 'feishu-session-console'
  ) {
    throw new RelayRouteFrameError('frame_invalid', 'accessSurface is invalid');
  }
  if ((value.accessCredentialId === null) !== (value.accessSurface === null)) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      'accessCredentialId and accessSurface must be present together',
    );
  }
}

export function assertRelayRouteFrame(
  frame: RelayRouteFrame,
  limits: RelayRouteFrameLimits = {},
): void {
  const maxFrameBytes = requirePositiveLimit(
    limits.maxFrameBytes ?? DEFAULT_MAX_ROUTE_FRAME_BYTES,
    'maxFrameBytes',
  );
  const maxCreditBytes = requirePositiveLimit(
    limits.maxCreditBytes ?? DEFAULT_MAX_ROUTE_CREDIT_BYTES,
    'maxCreditBytes',
  );
  const metadata: RouteMetadata = {
    version: ROUTE_VERSION,
    instanceId: frame.instanceId,
    generation: frame.generation,
    streamId: frame.streamId,
    direction: frame.direction,
    sequence: frame.sequence,
    kind: frame.kind,
    creditBytes: frame.creditBytes,
    resetCode: frame.resetCode,
    accessCredentialId: frame.accessCredentialId,
    accessSurface: frame.accessSurface,
  };
  assertMetadata(metadata);
  if (!(frame.payload instanceof Uint8Array)) {
    throw new RelayRouteFrameError('frame_invalid', 'payload must be Uint8Array');
  }
  const bodyBytes = routeBodyBytes(frame);
  if (bodyBytes > maxFrameBytes) {
    throw new RelayRouteFrameError(
      'frame_oversized',
      `Route frame is ${bodyBytes} bytes; limit is ${maxFrameBytes}`,
    );
  }
  if (frame.creditBytes !== null && frame.creditBytes > maxCreditBytes) {
    throw new RelayRouteFrameError('frame_invalid', 'creditBytes exceeds the negotiated limit');
  }

  const isControlStream = frame.streamId === RELAY_CONTROL_STREAM_ID;
  if (frame.kind === 'heartbeat') {
    if (!isControlStream || frame.payload.byteLength !== 0) {
      throw new RelayRouteFrameError(
        'frame_invalid',
        'heartbeat must use the lease control stream and have no payload',
      );
    }
  } else if (isControlStream) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      'Only heartbeat may use the lease control stream',
    );
  }

  if (frame.kind !== 'open' && (frame.accessCredentialId !== null || frame.accessSurface !== null)) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      'Only an open frame may carry an authenticated client context',
    );
  }
  if (frame.kind === 'data') {
    if (frame.payload.byteLength === 0 || frame.creditBytes !== null || frame.resetCode !== null) {
      throw new RelayRouteFrameError(
        'frame_invalid',
        'data requires a non-empty payload and no control fields',
      );
    }
    return;
  }
  if (frame.payload.byteLength !== 0) {
    throw new RelayRouteFrameError('frame_invalid', `${frame.kind} cannot carry payload bytes`);
  }
  if (frame.kind === 'credit') {
    if (frame.creditBytes === null || frame.resetCode !== null) {
      throw new RelayRouteFrameError('frame_invalid', 'credit requires creditBytes only');
    }
    return;
  }
  if (frame.kind === 'reset') {
    if (frame.resetCode === null || frame.creditBytes !== null) {
      throw new RelayRouteFrameError('frame_invalid', 'reset requires resetCode only');
    }
    return;
  }
  if (frame.creditBytes !== null || frame.resetCode !== null) {
    throw new RelayRouteFrameError('frame_invalid', `${frame.kind} cannot carry control fields`);
  }
  if (frame.kind === 'open' && frame.sequence !== 0) {
    throw new RelayRouteFrameError('frame_invalid', 'open must start at sequence zero');
  }
}

function metadataFor(frame: RelayRouteFrame): RouteMetadata {
  return {
    version: ROUTE_VERSION,
    instanceId: frame.instanceId,
    generation: frame.generation,
    streamId: frame.streamId,
    direction: frame.direction,
    sequence: frame.sequence,
    kind: frame.kind,
    creditBytes: frame.creditBytes,
    resetCode: frame.resetCode,
    accessCredentialId: frame.accessCredentialId,
    accessSurface: frame.accessSurface,
  };
}

function routeBodyBytes(frame: RelayRouteFrame): number {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataFor(frame))).byteLength;
  return ROUTE_METADATA_LENGTH_BYTES + metadataBytes + frame.payload.byteLength;
}

export function encodeRelayRouteFrame(
  frame: RelayRouteFrame,
  limits: RelayRouteFrameLimits = {},
): Uint8Array {
  assertRelayRouteFrame(frame, limits);
  const maxFrameBytes = requirePositiveLimit(
    limits.maxFrameBytes ?? DEFAULT_MAX_ROUTE_FRAME_BYTES,
    'maxFrameBytes',
  );
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataFor(frame)));
  const bodyBytes =
    ROUTE_METADATA_LENGTH_BYTES + metadataBytes.byteLength + frame.payload.byteLength;
  if (bodyBytes > maxFrameBytes) {
    throw new RelayRouteFrameError(
      'frame_oversized',
      `Route frame is ${bodyBytes} bytes; limit is ${maxFrameBytes}`,
    );
  }
  const encoded = new Uint8Array(ROUTE_PREFIX_BYTES + bodyBytes);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, bodyBytes, false);
  view.setUint32(ROUTE_PREFIX_BYTES, metadataBytes.byteLength, false);
  encoded.set(metadataBytes, ROUTE_PREFIX_BYTES + ROUTE_METADATA_LENGTH_BYTES);
  encoded.set(
    frame.payload,
    ROUTE_PREFIX_BYTES + ROUTE_METADATA_LENGTH_BYTES + metadataBytes.byteLength,
  );
  return encoded;
}

export function relayRouteFrameWireBytes(
  frame: RelayRouteFrame,
  limits: RelayRouteFrameLimits = {},
): number {
  return encodeRelayRouteFrame(frame, limits).byteLength;
}

function decodeBody(body: Uint8Array, limits: RelayRouteFrameLimits): RelayRouteFrame {
  if (body.byteLength < ROUTE_METADATA_LENGTH_BYTES) {
    throw new RelayRouteFrameError('frame_truncated', 'Route frame metadata length is truncated');
  }
  const metadataBytes = new DataView(
    body.buffer,
    body.byteOffset,
    ROUTE_METADATA_LENGTH_BYTES,
  ).getUint32(0, false);
  if (metadataBytes === 0 || metadataBytes > body.byteLength - ROUTE_METADATA_LENGTH_BYTES) {
    throw new RelayRouteFrameError('frame_truncated', 'Route frame metadata is truncated');
  }
  const metadataPayload = body.subarray(
    ROUTE_METADATA_LENGTH_BYTES,
    ROUTE_METADATA_LENGTH_BYTES + metadataBytes,
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataPayload));
  } catch (error) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      error instanceof Error ? error.message : 'Route metadata is not valid JSON',
    );
  }
  assertMetadata(metadata);
  const frame: RelayRouteFrame = {
    instanceId: metadata.instanceId,
    generation: metadata.generation,
    streamId: metadata.streamId,
    direction: metadata.direction,
    sequence: metadata.sequence,
    kind: metadata.kind,
    payload: body.slice(ROUTE_METADATA_LENGTH_BYTES + metadataBytes),
    creditBytes: metadata.creditBytes,
    resetCode: metadata.resetCode,
    accessCredentialId: metadata.accessCredentialId,
    accessSurface: metadata.accessSurface,
  };
  assertRelayRouteFrame(frame, limits);
  return frame;
}

export function decodeRelayRouteFrame(
  encoded: Uint8Array,
  limits: RelayRouteFrameLimits = {},
): RelayRouteFrame {
  if (encoded.byteLength < ROUTE_PREFIX_BYTES) {
    throw new RelayRouteFrameError('frame_truncated', 'Route frame length is truncated');
  }
  const declared = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    ROUTE_PREFIX_BYTES,
  ).getUint32(0, false);
  const maxFrameBytes = requirePositiveLimit(
    limits.maxFrameBytes ?? DEFAULT_MAX_ROUTE_FRAME_BYTES,
    'maxFrameBytes',
  );
  if (declared === 0 || declared > maxFrameBytes) {
    throw new RelayRouteFrameError(
      'frame_oversized',
      `Route frame declares invalid size ${declared}`,
    );
  }
  if (declared !== encoded.byteLength - ROUTE_PREFIX_BYTES) {
    throw new RelayRouteFrameError('frame_truncated', 'Route frame length does not match payload');
  }
  return decodeBody(encoded.subarray(ROUTE_PREFIX_BYTES), limits);
}

export class RelayRouteFrameDecoder {
  private partial = new Uint8Array(0);
  private partialBytes = 0;
  private partialTotalBytes = 0;
  readonly maxFrameBytes: number;

  constructor(readonly limits: RelayRouteFrameLimits = {}) {
    this.maxFrameBytes = requirePositiveLimit(
      limits.maxFrameBytes ?? DEFAULT_MAX_ROUTE_FRAME_BYTES,
      'maxFrameBytes',
    );
  }

  get bufferedBytes(): number {
    return this.partialBytes;
  }

  reset(): void {
    this.partial = new Uint8Array(0);
    this.partialBytes = 0;
    this.partialTotalBytes = 0;
  }

  push(chunk: Uint8Array): RelayRouteFrame[] {
    const frames: RelayRouteFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.partialBytes > 0) {
        if (this.partialBytes < ROUTE_PREFIX_BYTES) {
          const prefixBytes = Math.min(
            ROUTE_PREFIX_BYTES - this.partialBytes,
            chunk.byteLength - offset,
          );
          this.partial.set(chunk.subarray(offset, offset + prefixBytes), this.partialBytes);
          this.partialBytes += prefixBytes;
          offset += prefixBytes;
          if (this.partialBytes < ROUTE_PREFIX_BYTES) break;
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
          const body = this.partial.subarray(ROUTE_PREFIX_BYTES);
          this.reset();
          frames.push(decodeBody(body, this.limits));
        }
        continue;
      }
      const remaining = chunk.byteLength - offset;
      if (remaining < ROUTE_PREFIX_BYTES) {
        this.partial = new Uint8Array(ROUTE_PREFIX_BYTES);
        this.partial.set(chunk.subarray(offset));
        this.partialBytes = remaining;
        break;
      }
      const bodyBytes = this.declaredBodyBytes(chunk, offset);
      const totalBytes = ROUTE_PREFIX_BYTES + bodyBytes;
      if (remaining >= totalBytes) {
        frames.push(
          decodeBody(
            chunk.subarray(offset + ROUTE_PREFIX_BYTES, offset + totalBytes),
            this.limits,
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
    return frames;
  }

  private declaredBodyBytes(source: Uint8Array, offset: number): number {
    const bodyBytes = new DataView(
      source.buffer,
      source.byteOffset + offset,
      ROUTE_PREFIX_BYTES,
    ).getUint32(0, false);
    if (bodyBytes === 0 || bodyBytes > this.maxFrameBytes) {
      this.reset();
      throw new RelayRouteFrameError(
        'frame_oversized',
        `Route frame declares invalid size ${bodyBytes}`,
      );
    }
    return bodyBytes;
  }

  private allocatePartialBody(): void {
    const bodyBytes = this.declaredBodyBytes(this.partial, 0);
    const next = new Uint8Array(ROUTE_PREFIX_BYTES + bodyBytes);
    next.set(this.partial.subarray(0, ROUTE_PREFIX_BYTES));
    this.partial = next;
    this.partialTotalBytes = next.byteLength;
  }
}

export function emptyRoutePayload(): Uint8Array {
  return new Uint8Array(0);
}
