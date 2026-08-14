import {
  decodeRemoteOwnerGrantClaim,
  encodeRemoteOwnerGrantClaim,
  assertRemoteOwnerGrantForSurface,
  type RemoteOwnerGrantClaim,
  type RemoteOwnerGrantWireClaim,
} from '@contracts/index';

const CURRENT_ROUTE_VERSION = 2;
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
export type RelayClientSurface = 'desktop' | 'feishu';

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
  connectionScope: string | null;
  accessSurface: RelayClientSurface | null;
  accessGrant: RemoteOwnerGrantClaim | null;
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

export interface RouteMetadata {
  version: typeof CURRENT_ROUTE_VERSION;
  instanceId: string;
  generation: number;
  streamId: string;
  direction: RelayDirection;
  sequence: number;
  kind: RelayFrameKind;
  creditBytes: number | null;
  resetCode: RelayResetCode | null;
  connectionScope: string | null;
  accessSurface: RelayClientSurface | null;
  accessGrant: RemoteOwnerGrantWireClaim | null;
}

const DIRECTIONS = new Set<RelayDirection>(['client-to-worker', 'worker-to-client']);
const KINDS = new Set<RelayFrameKind>(['open', 'data', 'close', 'reset', 'credit', 'heartbeat']);
const RESET_CODES = new Set<RelayResetCode>([
  'backpressure', 'cancelled', 'generation_mismatch', 'heartbeat_timeout', 'protocol_error',
  'resync_required', 'worker_disconnected', 'worker_fenced', 'worker_offline',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/$-]+$/;
const COMMON_METADATA_KEYS = [
  'version', 'instanceId', 'generation', 'streamId', 'direction', 'sequence', 'kind',
  'creditBytes', 'resetCode',
] as const;
const CURRENT_METADATA_KEYS = new Set([
  ...COMMON_METADATA_KEYS, 'connectionScope', 'accessSurface', 'accessGrant',
]);

export function requirePositiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 160 ||
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

function assertExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new RelayRouteFrameError('frame_invalid', `Unknown route metadata field: ${key}`);
    }
  }
  if (Object.keys(value).length !== keys.size) {
    throw new RelayRouteFrameError('frame_invalid', 'Route metadata fields are incomplete');
  }
}

function assertCommonMetadata(value: Record<string, unknown>): void {
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
}

function assertCurrentMetadata(value: unknown): asserts value is RouteMetadata {
  if (!isRecord(value)) {
    throw new RelayRouteFrameError('frame_invalid', 'Route metadata must be an object');
  }
  assertExactKeys(value, CURRENT_METADATA_KEYS);
  if (value.version !== CURRENT_ROUTE_VERSION) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      `Unsupported route envelope version: ${String(value.version)}`,
    );
  }
  assertCommonMetadata(value);
  if (value.connectionScope !== null) assertIdentifier(value.connectionScope, 'connectionScope');
  if (
    value.accessSurface !== null && value.accessSurface !== 'desktop' &&
    value.accessSurface !== 'feishu'
  ) {
    throw new RelayRouteFrameError('frame_invalid', 'accessSurface is invalid');
  }
  if (
    (value.connectionScope === null) !== (value.accessSurface === null) ||
    (value.connectionScope === null) !== (value.accessGrant === null)
  ) {
    throw new RelayRouteFrameError(
      'frame_invalid',
      'connectionScope, accessSurface, and accessGrant must be present together',
    );
  }
  if (value.accessGrant !== null) {
    try {
      const grant = decodeRemoteOwnerGrantClaim(value.accessGrant);
      if (value.accessSurface !== 'desktop' && value.accessSurface !== 'feishu') throw new Error();
      assertRemoteOwnerGrantForSurface(grant, value.accessSurface);
    } catch {
      throw new RelayRouteFrameError('frame_invalid', 'accessGrant is invalid');
    }
  }
}

export function normalizeRouteMetadata(value: unknown): RouteMetadata {
  assertCurrentMetadata(value);
  return value;
}

export function metadataFor(frame: RelayRouteFrame): RouteMetadata {
  return {
    version: CURRENT_ROUTE_VERSION,
    instanceId: frame.instanceId,
    generation: frame.generation,
    streamId: frame.streamId,
    direction: frame.direction,
    sequence: frame.sequence,
    kind: frame.kind,
    creditBytes: frame.creditBytes,
    resetCode: frame.resetCode,
    connectionScope: frame.connectionScope,
    accessSurface: frame.accessSurface,
    accessGrant: frame.accessGrant === null ? null : encodeRemoteOwnerGrantClaim(frame.accessGrant),
  };
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
  assertCurrentMetadata(metadataFor(frame));
  if (!(frame.payload instanceof Uint8Array)) {
    throw new RelayRouteFrameError('frame_invalid', 'payload must be Uint8Array');
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataFor(frame))).byteLength;
  if (4 + metadataBytes + frame.payload.byteLength > maxFrameBytes) {
    throw new RelayRouteFrameError('frame_oversized', 'Route frame exceeds the negotiated limit');
  }
  if (frame.creditBytes !== null && frame.creditBytes > maxCreditBytes) {
    throw new RelayRouteFrameError('frame_invalid', 'creditBytes exceeds the negotiated limit');
  }
  const isControlStream = frame.streamId === RELAY_CONTROL_STREAM_ID;
  if (frame.kind === 'heartbeat') {
    if (!isControlStream || frame.payload.byteLength !== 0) {
      throw new RelayRouteFrameError(
        'frame_invalid', 'heartbeat must use the lease control stream and have no payload',
      );
    }
  } else if (isControlStream) {
    throw new RelayRouteFrameError('frame_invalid', 'Only heartbeat may use the lease control stream');
  }
  if (
    frame.kind !== 'open' &&
    (frame.connectionScope !== null || frame.accessSurface !== null || frame.accessGrant !== null)
  ) {
    throw new RelayRouteFrameError(
      'frame_invalid', 'Only an open frame may carry an authenticated client context',
    );
  }
  if (frame.kind === 'data') {
    if (frame.payload.byteLength === 0 || frame.creditBytes !== null || frame.resetCode !== null) {
      throw new RelayRouteFrameError(
        'frame_invalid', 'data requires a non-empty payload and no control fields',
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
