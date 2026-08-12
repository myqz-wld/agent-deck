import { encodeJsonFrame } from './frame';

export const CONTROL_FRAME_RESERVE = 2;
export const CONTROL_NONCE_MAX_UTF8_BYTES = 256;
export const MAX_ENCODED_CONTROL_FRAME_BYTES = encodeJsonFrame({
  type: 'pong',
  nonce: '\\'.repeat(CONTROL_NONCE_MAX_UTF8_BYTES),
}).byteLength;
export const MIN_ENCODED_NORMAL_FRAME_BYTES = encodeJsonFrame(null).byteLength;

export function controlFrameByteReserve(maxFrameBytes: number): number {
  const perFrame = Math.min(MAX_ENCODED_CONTROL_FRAME_BYTES, maxFrameBytes + 4);
  return CONTROL_FRAME_RESERVE * perFrame;
}

export function normalFrameLimit(maxQueuedFrames: number): number {
  return Math.max(1, maxQueuedFrames - CONTROL_FRAME_RESERVE);
}

export function normalByteLimit(maxQueuedBytes: number, maxFrameBytes: number): number {
  return maxQueuedBytes - controlFrameByteReserve(maxFrameBytes);
}

export function controlQueueCapacityError(limits: {
  maxFrameBytes: number;
  maxQueuedBytes: number;
  maxQueuedFrames: number;
}): string | null {
  if (limits.maxFrameBytes + 4 < MAX_ENCODED_CONTROL_FRAME_BYTES) {
    return 'maxFrameBytes cannot encode a maximum bounded control frame';
  }
  if (limits.maxQueuedFrames < CONTROL_FRAME_RESERVE + 1) {
    return `maxQueuedFrames must reserve ${CONTROL_FRAME_RESERVE} control frames and one normal frame`;
  }
  const minimumBytes = controlFrameByteReserve(limits.maxFrameBytes) +
    MIN_ENCODED_NORMAL_FRAME_BYTES;
  if (limits.maxQueuedBytes < minimumBytes) {
    return `maxQueuedBytes must be at least ${minimumBytes} bytes for control-frame liveness`;
  }
  return null;
}
