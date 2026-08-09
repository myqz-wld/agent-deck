import { describe, expect, it } from 'vitest';

import {
  encodeWorkerWireMessage,
  WorkerWireDecoder,
  type WorkerAttachRequest,
} from './attachment-wire';
import {
  assertRelayRouteFrame,
  decodeRelayRouteFrame,
  emptyRoutePayload,
  encodeRelayRouteFrame,
  RelayRouteFrameDecoder,
  RelayRouteFrameError,
  type RelayRouteFrame,
} from './route-frame';

function dataFrame(streamId: string, sequence: number, text: string): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 7,
    streamId,
    direction: 'client-to-worker',
    sequence,
    kind: 'data',
    payload: new TextEncoder().encode(text),
    creditBytes: null,
    resetCode: null,
    accessCredentialId: null,
    accessSurface: null,
  };
}

describe('Relay route framing', () => {
  it('decodes fragmented and coalesced opaque stream frames', () => {
    const first = encodeRelayRouteFrame(dataFrame('desktop-1', 1, '{"ordinary":"core"}'));
    const second = encodeRelayRouteFrame(dataFrame('feishu-2', 4, 'opaque\u0000bytes'));
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);

    const decoder = new RelayRouteFrameDecoder();
    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, first.byteLength + 9))).toEqual([
      expect.objectContaining({ streamId: 'desktop-1', sequence: 1, kind: 'data' }),
    ]);
    expect(decoder.push(combined.subarray(first.byteLength + 9))).toEqual([
      expect.objectContaining({ streamId: 'feishu-2', sequence: 4, kind: 'data' }),
    ]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('rejects invalid state fields before encoding', () => {
    expect(() =>
      encodeRelayRouteFrame({
        ...dataFrame('desktop-1', 1, 'body'),
        kind: 'credit',
        creditBytes: 10,
      }),
    ).toThrowError(expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_invalid' }));

    expect(() =>
      encodeRelayRouteFrame({
        ...dataFrame('desktop-1', 1, 'body'),
        streamId: '$lease',
      }),
    ).toThrowError('Only heartbeat may use the lease control stream');
  });

  it('round-trips authenticated context only on an open frame', () => {
    const open: RelayRouteFrame = {
      ...dataFrame('feishu-open', 0, ''),
      kind: 'open',
      payload: emptyRoutePayload(),
      accessCredentialId: 'feishu-credential-a',
      accessSurface: 'feishu-session-console',
    };
    expect(decodeRelayRouteFrame(encodeRelayRouteFrame(open))).toEqual(open);
    expect(() => encodeRelayRouteFrame({
      ...dataFrame('feishu-data', 1, 'body'),
      accessCredentialId: 'feishu-credential-a',
      accessSurface: 'feishu-session-console',
    })).toThrow('Only an open frame');
    expect(() => encodeRelayRouteFrame({
      ...open,
      accessSurface: null,
    })).toThrow('must be present together');
  });

  it('enforces exact negotiated body bytes for in-memory and direct decode boundaries', () => {
    const frame = dataFrame('bounded-stream', 1, 'payload');
    const encoded = encodeRelayRouteFrame(frame);
    const exactBodyBytes = encoded.byteLength - 4;

    expect(() => assertRelayRouteFrame(frame, { maxFrameBytes: exactBodyBytes })).not.toThrow();
    expect(() => decodeRelayRouteFrame(encoded, { maxFrameBytes: exactBodyBytes })).not.toThrow();
    expect(() => assertRelayRouteFrame(frame, { maxFrameBytes: exactBodyBytes - 1 })).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
    expect(() => decodeRelayRouteFrame(encoded, { maxFrameBytes: exactBodyBytes - 1 })).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
    expect(() => decodeRelayRouteFrame(new Uint8Array(4), { maxFrameBytes: 1 })).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
  });

  it('rejects an oversized declaration before buffering a body', () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, 4097, false);
    const decoder = new RelayRouteFrameDecoder({ maxFrameBytes: 4096 });
    expect(() => decoder.push(prefix)).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
  });

  it('rejects one oversized chunk without retaining it and streams large coalescing', () => {
    const oversized = new Uint8Array(1024 * 1024);
    new DataView(oversized.buffer).setUint32(0, 4097, false);
    const rejecting = new RelayRouteFrameDecoder({ maxFrameBytes: 4096 });
    expect(() => rejecting.push(oversized)).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
    expect(rejecting.bufferedBytes).toBe(0);

    const first = encodeRelayRouteFrame(dataFrame('stream-a', 1, 'x'));
    const second = encodeRelayRouteFrame(dataFrame('stream-b', 2, 'y'));
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);
    const maxBodyBytes = Math.max(first.byteLength, second.byteLength) - 4;
    const decoder = new RelayRouteFrameDecoder({ maxFrameBytes: maxBodyBytes });
    expect(combined.byteLength).toBeGreaterThan(maxBodyBytes);
    expect(decoder.push(combined)).toHaveLength(2);
    expect(decoder.bufferedBytes).toBe(0);
  });
});

describe('Worker attachment wire', () => {
  it('keeps registration separate and preserves a following route frame', () => {
    const attach: WorkerAttachRequest = {
      type: 'attach',
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'credential-a',
      mode: 'reconnect',
      generation: 7,
      expectedGeneration: null,
    };
    const first = encodeWorkerWireMessage(attach);
    const second = encodeWorkerWireMessage({ type: 'route', frame: dataFrame('desktop-1', 1, 'x') });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);
    const decoder = new WorkerWireDecoder();

    expect(decoder.push(combined.subarray(0, 11))).toEqual([]);
    const messages = decoder.push(combined.subarray(11));
    expect(messages[0]).toEqual(attach);
    expect(messages[1]).toEqual({
      type: 'route',
      frame: expect.objectContaining({
        streamId: 'desktop-1',
        payload: new TextEncoder().encode('x'),
      }),
    });
  });

  it('requires explicit generation semantics for reconnect and takeover', () => {
    const invalid = {
      type: 'attach' as const,
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'credential-a',
      mode: 'reconnect' as const,
      generation: null,
      expectedGeneration: null,
    };
    const encoded = encodeWorkerWireMessage(invalid);
    expect(() => new WorkerWireDecoder().push(encoded)).toThrow('reconnect requires generation');
  });

  it.each([
    ['register', 1, null],
    ['register', null, 0],
    ['reconnect', 1, 0],
    ['takeover', 1, 1],
    ['takeover', null, Number.MAX_SAFE_INTEGER],
  ] as const)(
    'rejects non-exact %s generation fields (%s, %s)',
    (mode, generation, expectedGeneration) => {
      const encoded = encodeWorkerWireMessage({
        type: 'attach',
        instanceId: 'instance-a',
        workerId: 'worker-a',
        credentialId: 'credential-a',
        mode,
        generation,
        expectedGeneration,
      });
      expect(() => new WorkerWireDecoder().push(encoded)).toThrow();
    },
  );

  it('round-trips exact negotiated route limits and rejects incoherent credit', () => {
    const attached = {
      type: 'attached' as const,
      instanceId: 'instance-a',
      workerId: 'worker-a',
      generation: 1,
      heartbeatTimeoutMs: 30,
      initialCreditBytes: 1024,
      maxCreditBytes: 4096,
      maxFrameBytes: 8192,
    };
    expect(new WorkerWireDecoder().push(encodeWorkerWireMessage(attached))).toEqual([attached]);
    expect(() =>
      new WorkerWireDecoder().push(
        encodeWorkerWireMessage({ ...attached, initialCreditBytes: 4097 }),
      ),
    ).toThrow('initialCreditBytes cannot exceed maxCreditBytes');
  });

  it('requires byte-bounded control-safe identity and rejection text', () => {
    const attach: WorkerAttachRequest = {
      type: 'attach',
      instanceId: 'instance-a',
      workerId: 'worker\nspoofed',
      credentialId: 'credential-a',
      mode: 'register',
      generation: null,
      expectedGeneration: null,
    };
    expect(() => new WorkerWireDecoder().push(encodeWorkerWireMessage(attach))).toThrow(
      'workerId',
    );
    expect(() =>
      new WorkerWireDecoder().push(
        encodeWorkerWireMessage({
          type: 'rejected',
          code: 'invalid_attach',
          message: '€'.repeat(171),
          retryable: false,
          currentGeneration: null,
        }),
      ),
    ).toThrow('bounded non-empty UTF-8 string');
    expect(() =>
      new WorkerWireDecoder().push(
        encodeWorkerWireMessage({
          type: 'rejected',
          code: 'invalid_attach',
          message: 'bad\u0085message',
          retryable: false,
          currentGeneration: null,
        }),
      ),
    ).toThrow('control characters');
  });

  it('rejects oversized input without retaining it while decoding valid coalescing', () => {
    const oversized = new Uint8Array(1024 * 1024);
    new DataView(oversized.buffer).setUint32(0, 4097, false);
    const rejecting = new WorkerWireDecoder(4096);
    expect(() => rejecting.push(oversized)).toThrow('declares invalid size 4097');
    expect(rejecting.bufferedBytes).toBe(0);

    const first = encodeWorkerWireMessage({
      type: 'route',
      frame: dataFrame('stream-a', 1, 'x'),
    });
    const second = encodeWorkerWireMessage({
      type: 'route',
      frame: dataFrame('stream-b', 2, 'y'),
    });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);
    const maxBodyBytes = Math.max(first.byteLength, second.byteLength) - 4;
    const decoder = new WorkerWireDecoder(maxBodyBytes);
    expect(combined.byteLength).toBeGreaterThan(maxBodyBytes);
    expect(decoder.push(combined)).toHaveLength(2);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('round-trips control frames without a payload slot', () => {
    const encoded = encodeRelayRouteFrame({
      instanceId: 'instance-a',
      generation: 7,
      streamId: 'desktop-1',
      direction: 'worker-to-client',
      sequence: 9,
      kind: 'reset',
      payload: emptyRoutePayload(),
      creditBytes: null,
      resetCode: 'worker_fenced',
      accessCredentialId: null,
      accessSurface: null,
    });
    expect(new RelayRouteFrameDecoder().push(encoded)[0]).toEqual(
      expect.objectContaining({ kind: 'reset', resetCode: 'worker_fenced' }),
    );
  });
});
