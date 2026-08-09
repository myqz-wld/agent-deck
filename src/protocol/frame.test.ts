import { describe, expect, it } from 'vitest';

import {
  encodeJsonFrame,
  LengthPrefixedJsonDecoder,
  ProtocolFrameError,
} from './frame';

describe('length-prefixed JSON framing', () => {
  it('decodes fragmented and coalesced frames deterministically', () => {
    const first = encodeJsonFrame({ streamId: 'desktop', sequence: 1 });
    const second = encodeJsonFrame({ streamId: 'feishu', sequence: 1 });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);

    const decoder = new LengthPrefixedJsonDecoder();
    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(3);
    expect(decoder.push(combined.subarray(3, first.byteLength + 7))).toEqual([
      { streamId: 'desktop', sequence: 1 },
    ]);
    expect(decoder.push(combined.subarray(first.byteLength + 7))).toEqual([
      { streamId: 'feishu', sequence: 1 },
    ]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('rejects an oversized frame before buffering its payload', () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 1025, false);
    const decoder = new LengthPrefixedJsonDecoder(1024);

    expect(() => decoder.push(header)).toThrowError(
      expect.objectContaining<Partial<ProtocolFrameError>>({ code: 'frame_oversized' }),
    );
  });

  it('rejects invalid JSON and non-finite numbers', () => {
    const invalidPayload = new TextEncoder().encode('{');
    const invalidFrame = new Uint8Array(4 + invalidPayload.byteLength);
    new DataView(invalidFrame.buffer).setUint32(0, invalidPayload.byteLength, false);
    invalidFrame.set(invalidPayload, 4);

    expect(() => new LengthPrefixedJsonDecoder().push(invalidFrame)).toThrowError(
      expect.objectContaining<Partial<ProtocolFrameError>>({ code: 'frame_invalid_json' }),
    );
    expect(() => encodeJsonFrame(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining<Partial<ProtocolFrameError>>({ code: 'frame_not_json_value' }),
    );
  });
});
