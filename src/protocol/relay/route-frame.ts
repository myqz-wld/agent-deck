import {
  copyRemoteOwnerGrantClaim,
  decodeRemoteOwnerGrantClaim,
} from '@contracts/index';
import {
  assertRelayRouteFrame,
  DEFAULT_MAX_ROUTE_FRAME_BYTES,
  metadataFor,
  normalizeRouteMetadata,
  RelayRouteFrameError,
  requirePositiveLimit,
  type RelayRouteFrame,
  type RelayRouteFrameLimits,
} from './route-frame-contract';

export {
  assertRelayRouteFrame,
  DEFAULT_MAX_ROUTE_CREDIT_BYTES,
  DEFAULT_MAX_ROUTE_FRAME_BYTES,
  RELAY_CONTROL_STREAM_ID,
  RelayRouteFrameError,
} from './route-frame-contract';
export type {
  RelayClientSurface,
  RelayDirection,
  RelayFrameKind,
  RelayResetCode,
  RelayRouteFrame,
  RelayRouteFrameErrorCode,
  RelayRouteFrameLimits,
} from './route-frame-contract';

const ROUTE_PREFIX_BYTES = 4;
const ROUTE_METADATA_LENGTH_BYTES = 4;

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
  const normalized = normalizeRouteMetadata(metadata);
  const frame: RelayRouteFrame = {
    instanceId: normalized.instanceId,
    generation: normalized.generation,
    streamId: normalized.streamId,
    direction: normalized.direction,
    sequence: normalized.sequence,
    kind: normalized.kind,
    payload: body.slice(ROUTE_METADATA_LENGTH_BYTES + metadataBytes),
    creditBytes: normalized.creditBytes,
    resetCode: normalized.resetCode,
    connectionScope: normalized.connectionScope,
    accessSurface: normalized.accessSurface,
    accessGrant: normalized.accessGrant === null
      ? null
      : copyRemoteOwnerGrantClaim(decodeRemoteOwnerGrantClaim(normalized.accessGrant)),
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

export function emptyRoutePayload(): Uint8Array {
  return new Uint8Array(0);
}
