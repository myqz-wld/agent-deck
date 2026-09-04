import { describe, expect, it, vi } from 'vitest';

import { LocalWorkerFrameBridge, type CoreFrameOutput } from '../../hosts/local-worker/frame-bridge';
import { RelayMetadataStore } from '../../hosts/relay/metadata';
import {
  emptyRoutePayload,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';
import { RelayStreamRouter } from '../../hosts/relay/router';
import { RelayClientBridgeError, RelayClientFrameBridge } from '@protocol/relay/client-bridge';

function inbound(
  generation: number,
  streamId: string,
  sequence: number,
  kind: RelayRouteFrame['kind'],
  options: {
    payload?: Uint8Array;
    creditBytes?: number | null;
    resetCode?: RelayResetCode | null;
  } = {},
): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation,
    streamId,
    direction: 'worker-to-client',
    sequence,
    kind,
    payload: options.payload ?? emptyRoutePayload(),
    creditBytes: options.creditBytes ?? null,
    resetCode: options.resetCode ?? null,
    connectionScope: null,
    accessSurface: null,
    accessGrant: null,
  };
}

describe('Relay client byte-stream bridge', () => {
  it('reports worker_offline explicitly instead of presenting an empty Core', () => {
    const emitted: RelayRouteFrame[] = [];
    const reset = vi.fn();
    const bridge = new RelayClientFrameBridge('instance-a', 0, (frame) => emitted.push(frame));
    bridge.open('stream-a', { data: vi.fn(), close: vi.fn(), reset });
    expect(emitted).toEqual([expect.objectContaining({ kind: 'open', generation: 0 })]);

    bridge.accept(inbound(0, 'stream-a', 0, 'reset', { resetCode: 'worker_offline' }));
    expect(reset).toHaveBeenCalledWith('worker_offline');
    expect(bridge.streamCount()).toBe(0);
  });

  it('queues only up to the per-stream/client byte cap and cancels on overflow', () => {
    const emitted: RelayRouteFrame[] = [];
    const reset = vi.fn();
    const bridge = new RelayClientFrameBridge(
      'instance-a',
      1,
      (frame) => emitted.push(frame),
      {
        initialCreditBytes: 4,
        maxCreditBytes: 4,
        maxQueueBytesPerStream: 5,
        maxQueueBytesPerClient: 10,
        maxQueueFramesPerStream: 5,
        maxQueueFramesPerClient: 10,
        maxFrameBytes: 1024,
      },
    );
    const stream = bridge.open('stream-a', { data: vi.fn(), close: vi.fn(), reset });
    stream.send(new Uint8Array(4));
    stream.send(new Uint8Array(5));
    expect(() => stream.send(new Uint8Array(1))).toThrowError(
      expect.objectContaining<Partial<RelayClientBridgeError>>({ code: 'backpressure' }),
    );
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ kind: 'reset', resetCode: 'backpressure' }),
    );
    expect(reset).toHaveBeenCalledWith('backpressure');
    expect(bridge.queuedOutputBytes()).toBe(0);
  });

  it('flushes queued client data only after bounded Worker credit arrives', () => {
    const emitted: RelayRouteFrame[] = [];
    const bridge = new RelayClientFrameBridge(
      'instance-a',
      1,
      (frame) => emitted.push(frame),
      {
        initialCreditBytes: 4,
        maxCreditBytes: 4,
        maxQueueBytesPerStream: 8,
        maxQueueBytesPerClient: 16,
        maxQueueFramesPerStream: 8,
        maxQueueFramesPerClient: 16,
        maxFrameBytes: 1024,
      },
    );
    const stream = bridge.open('stream-a', { data: vi.fn(), close: vi.fn(), reset: vi.fn() });
    stream.send(new Uint8Array(4));
    stream.send(new Uint8Array(2));
    expect(emitted.filter((frame) => frame.kind === 'data')).toHaveLength(1);

    bridge.accept(inbound(1, 'stream-a', 0, 'credit', { creditBytes: 2 }));
    expect(emitted.filter((frame) => frame.kind === 'data')).toHaveLength(2);
    expect(bridge.queuedOutputBytes()).toBe(0);
  });

  it('bounds tiny queued objects independently of payload byte count', () => {
    const bridge = new RelayClientFrameBridge('instance-a', 1, vi.fn(), {
      initialCreditBytes: 1,
      maxCreditBytes: 1,
      maxQueueBytesPerStream: 100,
      maxQueueBytesPerClient: 100,
      maxQueueFramesPerStream: 2,
      maxQueueFramesPerClient: 3,
      maxFrameBytes: 1024,
    });
    const reset = vi.fn();
    const stream = bridge.open('tiny-stream', { data: vi.fn(), close: vi.fn(), reset });
    stream.send(new Uint8Array([1]));
    stream.send(new Uint8Array([2]));
    stream.send(new Uint8Array([3]));
    expect(() => stream.send(new Uint8Array([4]))).toThrowError(
      expect.objectContaining<Partial<RelayClientBridgeError>>({ code: 'backpressure' }),
    );
    expect(reset).toHaveBeenCalledWith('backpressure');
    expect(bridge.queuedOutputBytes()).toBe(0);
    expect(bridge.queuedOutputFrames()).toBe(0);
    expect(bridge.streamCount()).toBe(0);
  });

  it('enforces the total tiny-frame cap without dropping another stream', () => {
    const bridge = new RelayClientFrameBridge('instance-a', 1, vi.fn(), {
      initialCreditBytes: 1,
      maxCreditBytes: 1,
      maxQueueBytesPerStream: 100,
      maxQueueBytesPerClient: 100,
      maxQueueFramesPerStream: 2,
      maxQueueFramesPerClient: 2,
      maxFrameBytes: 1024,
    });
    const resetA = vi.fn();
    const streamA = bridge.open('stream-a', { data: vi.fn(), close: vi.fn(), reset: resetA });
    const streamB = bridge.open('stream-b', { data: vi.fn(), close: vi.fn(), reset: vi.fn() });
    streamA.send(new Uint8Array([1]));
    streamB.send(new Uint8Array([1]));
    streamA.send(new Uint8Array([2]));
    streamB.send(new Uint8Array([2]));
    expect(() => streamA.send(new Uint8Array([3]))).toThrow('queue limit exceeded');
    expect(resetA).toHaveBeenCalledWith('backpressure');
    expect(bridge.streamCount()).toBe(1);
    expect(bridge.queuedOutputFrames()).toBe(1);
    streamB.cancel();
    expect(bridge.queuedOutputFrames()).toBe(0);
  });

  it('cleans only the affected stream when emit or listener callbacks throw', () => {
    const bridge = new RelayClientFrameBridge('instance-a', 1, (frame) => {
      if (frame.streamId === 'stream-a' && frame.kind === 'data') throw new Error('emit failed');
    });
    const streamA = bridge.open('stream-a', {
      data: vi.fn(),
      close: vi.fn(),
      reset: () => {
        throw new Error('reset failed');
      },
    });
    bridge.open('stream-b', {
      data: vi.fn(),
      close: () => {
        throw new Error('close failed');
      },
      reset: vi.fn(),
    });
    expect(() => streamA.send(new Uint8Array([1]))).toThrow('emission failed');
    expect(bridge.streamCount()).toBe(1);
    expect(bridge.queuedOutputBytes()).toBeGreaterThanOrEqual(0);
    expect(bridge.queuedOutputFrames()).toBeGreaterThanOrEqual(0);

    bridge.accept(inbound(1, 'stream-b', 0, 'close'));
    expect(bridge.streamCount()).toBe(0);
  });

  it('validates stream ids before insertion and fully cleans resynchronization', () => {
    const emit = vi.fn();
    const bridge = new RelayClientFrameBridge('instance-a', 1, emit);
    expect(() =>
      bridge.open('invalid stream id', { data: vi.fn(), close: vi.fn(), reset: vi.fn() }),
    ).toThrow('valid Relay id');
    expect(bridge.streamCount()).toBe(0);
    expect(emit).not.toHaveBeenCalled();

    bridge.open('stream-a', {
      data: vi.fn(),
      close: vi.fn(),
      reset: () => {
        throw new Error('observer failed');
      },
    });
    bridge.open('stream-b', { data: vi.fn(), close: vi.fn(), reset: vi.fn() });
    expect(() => bridge.resynchronize(2)).not.toThrow();
    expect(bridge.generation()).toBe(2);
    expect(bridge.streamCount()).toBe(0);
  });

  it.each(['cancel', 'resynchronize'] as const)(
    'does not emit stale credit when a data listener performs %s',
    (action) => {
      const emitted: RelayRouteFrame[] = [];
      const reset = vi.fn();
      let stream!: ReturnType<RelayClientFrameBridge['open']>;
      const bridge = new RelayClientFrameBridge('instance-a', 1, (frame) => emitted.push(frame));
      stream = bridge.open('listener-reentry', {
        data() {
          if (action === 'cancel') stream.cancel();
          else {
            bridge.resynchronize(2);
            bridge.open('listener-reentry', {
              data: vi.fn(),
              close: vi.fn(),
              reset: vi.fn(),
            });
          }
        },
        close: vi.fn(),
        reset,
      });

      const emittedBeforeData = emitted.length;
      bridge.accept(
        inbound(1, 'listener-reentry', 0, 'data', { payload: new Uint8Array([1]) }),
      );

      expect(emitted.slice(emittedBeforeData).some((frame) => frame.kind === 'credit')).toBe(false);
      expect(bridge.streamCount()).toBe(action === 'cancel' ? 0 : 1);
      expect(bridge.queuedOutputBytes()).toBeGreaterThanOrEqual(0);
      expect(bridge.queuedOutputFrames()).toBeGreaterThanOrEqual(0);
      if (action === 'resynchronize') expect(reset).toHaveBeenCalledWith('resync_required');
    },
  );

  it.each(['cancel', 'resynchronize'] as const)(
    'does not mutate a reused stream when data emit performs %s',
    (action) => {
      const emitted: RelayRouteFrame[] = [];
      let dataEmissions = 0;
      let original!: ReturnType<RelayClientFrameBridge['open']>;
      let replacement: ReturnType<RelayClientFrameBridge['open']> | null = null;
      const listener = { data: vi.fn(), close: vi.fn(), reset: vi.fn() };
      const bridge = new RelayClientFrameBridge(
        'instance-a',
        1,
        (frame) => {
          emitted.push({ ...frame, payload: frame.payload.slice() });
          if (frame.kind !== 'data' || ++dataEmissions !== 2) return;
          if (action === 'cancel') original.cancel();
          else {
            bridge.resynchronize(2);
            replacement = bridge.open('emit-reentry', listener);
          }
        },
        {
          initialCreditBytes: 1,
          maxCreditBytes: 2,
          maxQueueBytesPerStream: 4,
          maxQueueBytesPerClient: 4,
          maxQueueFramesPerStream: 4,
          maxQueueFramesPerClient: 4,
          maxFrameBytes: 1024,
        },
      );
      original = bridge.open('emit-reentry', listener);

      original.send(new Uint8Array([1]));
      original.send(new Uint8Array([2]));
      expect(bridge.queuedOutputFrames()).toBe(1);
      bridge.accept(inbound(1, 'emit-reentry', 0, 'credit', { creditBytes: 1 }));
      expect(bridge.queuedOutputBytes()).toBe(0);
      expect(bridge.queuedOutputFrames()).toBe(0);
      if (replacement === null) replacement = bridge.open('emit-reentry', listener);
      const replacementStart = emitted.length;
      replacement.send(new Uint8Array([2]));

      expect(emitted.slice(replacementStart)).toEqual([
        expect.objectContaining({ kind: 'data', sequence: 1 }),
      ]);
      expect(bridge.streamCount()).toBe(1);
      expect(bridge.queuedOutputBytes()).toBeGreaterThanOrEqual(0);
      expect(bridge.queuedOutputFrames()).toBeGreaterThanOrEqual(0);
    },
  );

  it('does not let a stale stream handle affect a reused stream id', () => {
    const emitted: RelayRouteFrame[] = [];
    const bridge = new RelayClientFrameBridge('instance-a', 1, (frame) => emitted.push(frame));
    const first = bridge.open('reused-stream', {
      data: vi.fn(),
      close: vi.fn(),
      reset: vi.fn(),
    });
    first.cancel();
    bridge.open('reused-stream', { data: vi.fn(), close: vi.fn(), reset: vi.fn() });
    const emittedBeforeStaleCalls = emitted.length;

    expect(() => first.send(new Uint8Array([1]))).toThrowError(
      expect.objectContaining<Partial<RelayClientBridgeError>>({ code: 'cancelled' }),
    );
    first.close();
    first.cancel();
    expect(emitted).toHaveLength(emittedBeforeStaleCalls);
    expect(bridge.streamCount()).toBe(1);
  });
});

describe('Relay client -> router -> local Worker integration', () => {
  it('round-trips opaque Core frames above initial credit and forwards cancellation', () => {
    const metadata = new RelayMetadataStore();
    metadata.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 0,
    });
    for (const [credentialId, kind] of [
      ['worker-credential-a', 'relay-worker'],
      ['client-credential-a', 'ssh-client'],
    ] as const) {
      metadata.put('credentials', {
        id: credentialId,
        instanceId: 'instance-a',
        credentialId,
        kind,
        publicKey: 'ssh-ed25519 AAAATEST',
        fingerprint: `SHA256:${credentialId}`,
        status: 'active',
        createdAt: 1,
        revokedAt: null,
      });
    }
    const router = new RelayStreamRouter('instance-a', metadata, undefined, 0);
    router.attachWorker(
      {
        type: 'attach',
        instanceId: 'instance-a',
        workerId: 'worker-a',
        credentialId: 'worker-credential-a',
        mode: 'register',
        generation: null,
        expectedGeneration: null,
      },
      'connection-1',
      1,
    );
    router.registerClient('client-a', 'client-credential-a');

    let coreOutput: CoreFrameOutput | null = null;
    const coreReset = vi.fn();
    const workerBridge = new LocalWorkerFrameBridge(
      'instance-a',
      1,
      {
        open(_streamId, output) {
          coreOutput = output;
          return {
            write(payload) {
              coreOutput?.data(payload);
              return true;
            },
            closeInput: vi.fn(),
            reset: coreReset,
          };
        },
      },
      (frame) => {
        router.routeFromWorker('connection-1', frame, 2);
      },
    );
    const received: Uint8Array[] = [];
    const clientBridge = new RelayClientFrameBridge('instance-a', 1, (frame) => {
      router.routeFromClient('client-a', frame);
    });
    const stream = clientBridge.open('roundtrip', {
      data: (payload) => received.push(payload.slice()),
      close: vi.fn(),
      reset: vi.fn(),
    });

    const pumpToWorker = (): void => {
      for (const frame of router.drainWorker()?.frames ?? []) workerBridge.accept(frame);
    };
    const pumpToClient = (): void => {
      for (const frame of router.drainClient('client-a')) clientBridge.accept(frame);
    };

    pumpToWorker();
    stream.send(new TextEncoder().encode('{"type":"request","opaque":true}'));
    pumpToWorker();
    pumpToClient();
    pumpToWorker();
    expect(new TextDecoder().decode(received[0])).toBe('{"type":"request","opaque":true}');

    const largeResponse = new Uint8Array(280 * 1024);
    for (let index = 0; index < largeResponse.byteLength; index += 1) {
      largeResponse[index] = index % 251;
    }
    const activeCoreOutput = coreOutput as CoreFrameOutput | null;
    if (!activeCoreOutput) throw new Error('Missing Core output');
    activeCoreOutput.data(largeResponse);
    pumpToClient();
    pumpToWorker();
    pumpToClient();
    pumpToWorker();
    expect(Buffer.concat(received.slice(1).map((payload) => Buffer.from(payload))))
      .toEqual(Buffer.from(largeResponse));
    expect(workerBridge.queuedOutputBytes()).toBe(0);

    stream.cancel();
    pumpToWorker();
    expect(coreReset).toHaveBeenCalledWith('cancelled');
    expect(workerBridge.streamCount()).toBe(0);
    expect(clientBridge.streamCount()).toBe(0);
    expect(metadata.exportSnapshot()).not.toContain('{"type":"request"');
  });
});
