import { isJsonValue, type JsonValue } from '@contracts/json';

const FRAME_HEADER_BYTES = 4;
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type ProtocolFrameErrorCode =
  | 'frame_empty'
  | 'frame_invalid_json'
  | 'frame_not_json_value'
  | 'frame_oversized';

export class ProtocolFrameError extends Error {
  constructor(
    readonly code: ProtocolFrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolFrameError';
  }
}

function assertFrameSize(size: number, maxFrameBytes: number): void {
  if (size === 0) {
    throw new ProtocolFrameError('frame_empty', 'Protocol frames cannot be empty');
  }
  if (size > maxFrameBytes) {
    throw new ProtocolFrameError(
      'frame_oversized',
      `Protocol frame is ${size} bytes; limit is ${maxFrameBytes}`,
    );
  }
}

export function encodeJsonFrame(
  value: JsonValue,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  if (!isJsonValue(value)) {
    throw new ProtocolFrameError('frame_not_json_value', 'Frame payload is not JSON-safe');
  }

  const payload = new TextEncoder().encode(JSON.stringify(value));
  assertFrameSize(payload.byteLength, maxFrameBytes);

  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export class LengthPrefixedJsonDecoder {
  private buffered = new Uint8Array(0);

  constructor(readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError('maxFrameBytes must be a positive safe integer');
    }
  }

  get bufferedBytes(): number {
    return this.buffered.byteLength;
  }

  reset(): void {
    this.buffered = new Uint8Array(0);
  }

  push(chunk: Uint8Array): JsonValue[] {
    if (chunk.byteLength > 0) {
      const combined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
      combined.set(this.buffered);
      combined.set(chunk, this.buffered.byteLength);
      this.buffered = combined;
    }

    const values: JsonValue[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        FRAME_HEADER_BYTES,
      );
      const payloadBytes = view.getUint32(0, false);
      assertFrameSize(payloadBytes, this.maxFrameBytes);
      const frameBytes = FRAME_HEADER_BYTES + payloadBytes;
      if (this.buffered.byteLength - offset < frameBytes) break;

      const payload = this.buffered.subarray(
        offset + FRAME_HEADER_BYTES,
        offset + frameBytes,
      );
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      } catch (error) {
        throw new ProtocolFrameError(
          'frame_invalid_json',
          error instanceof Error ? error.message : 'Frame contains invalid JSON',
        );
      }
      if (!isJsonValue(decoded)) {
        throw new ProtocolFrameError(
          'frame_not_json_value',
          'Decoded frame is not a JSON-safe value',
        );
      }
      values.push(decoded);
      offset += frameBytes;
    }

    if (offset > 0) this.buffered = this.buffered.slice(offset);
    return values;
  }
}
