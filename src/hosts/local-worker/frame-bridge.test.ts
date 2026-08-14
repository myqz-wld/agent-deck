import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';

import {
  emptyRoutePayload,
  RelayRouteFrameError,
  type RelayRouteFrame,
} from '@protocol/relay';
import {
  LocalWorkerFrameBridge,
  type CoreFrameChannel,
  type CoreFrameOutput,
} from './frame-bridge';

function inbound(
  streamId: string,
  sequence: number,
  kind: RelayRouteFrame['kind'],
  options: {
    payload?: Uint8Array;
    creditBytes?: number | null;
    resetCode?: RelayRouteFrame['resetCode'];
  } = {},
): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 3,
    streamId,
    direction: 'client-to-worker',
    sequence,
    kind,
    payload: options.payload ?? emptyRoutePayload(),
    creditBytes: options.creditBytes ?? null,
    resetCode: options.resetCode ?? null,
    connectionScope: kind === 'open' ? 'client-credential-a' : null,
    accessSurface: kind === 'open' ? 'desktop' : null,
    accessGrant: kind === 'open' ? issueRemoteOwnerGrantClaim('desktop') : null,
  };
}

describe('local Worker generic Core frame bridge', () => {
  it('bridges opaque Core frames and returns byte credit after consumption', () => {
    const emitted: RelayRouteFrame[] = [];
    const writes: Uint8Array[] = [];
    const accesses: unknown[] = [];
    const output: { current: CoreFrameOutput | null } = { current: null };
    const channel: CoreFrameChannel = {
      write(payload) {
        writes.push(payload.slice());
        output.current?.data(payload);
        return true;
      },
      closeInput: vi.fn(),
      reset: vi.fn(),
    };
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, nextOutput, access) {
          output.current = nextOutput;
          accesses.push(access);
          return channel;
        },
      },
      (frame) => emitted.push(frame),
    );

    bridge.accept(inbound('stream-a', 0, 'open'));
    bridge.accept(
      inbound('stream-a', 1, 'data', { payload: new TextEncoder().encode('ordinary-core-frame') }),
    );
    expect(writes.map((payload) => new TextDecoder().decode(payload))).toEqual([
      'ordinary-core-frame',
    ]);
    expect(accesses).toEqual([
      expect.objectContaining({
        connectionScope: 'client-credential-a',
        surface: 'desktop',
      }),
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({ kind: 'data', sequence: 0 }),
      expect.objectContaining({
        kind: 'credit',
        sequence: 1,
        creditBytes: new TextEncoder().encode('ordinary-core-frame').byteLength,
      }),
    ]);

    bridge.accept(
      inbound('stream-a', 2, 'credit', {
        creditBytes: new TextEncoder().encode('ordinary-core-frame').byteLength,
      }),
    );
    bridge.accept(inbound('stream-a', 3, 'reset', { resetCode: 'cancelled' }));
    expect(channel.reset).toHaveBeenCalledWith('cancelled');
    expect(bridge.streamCount()).toBe(0);
  });

  it('hard-resets one stream when its Core output queue exceeds the bound', () => {
    const emitted: RelayRouteFrame[] = [];
    const reset = vi.fn();
    const output: { current: CoreFrameOutput | null } = { current: null };
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, nextOutput) {
          output.current = nextOutput;
          return { write: () => true, closeInput: vi.fn(), reset };
        },
      },
      (frame) => emitted.push(frame),
      {
        initialCreditBytes: 4,
        maxCreditBytes: 4,
        maxOutputQueueBytesPerStream: 6,
        maxOutputQueueBytesTotal: 12,
        maxOutputQueueFramesPerStream: 6,
        maxOutputQueueFramesTotal: 12,
        maxFrameBytes: 1024,
      },
    );
    bridge.accept(inbound('stream-a', 0, 'open'));
    output.current?.data(new Uint8Array(4));
    output.current?.data(new Uint8Array(5));
    output.current?.data(new Uint8Array(2));

    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ kind: 'reset', resetCode: 'backpressure' }),
    );
    expect(reset).toHaveBeenCalledWith('backpressure');
    expect(bridge.queuedOutputBytes()).toBe(0);
    expect(bridge.streamCount()).toBe(0);
  });

  it('fragments Core output above initial credit so returned credit can drain it', () => {
    const emitted: RelayRouteFrame[] = [];
    const output: { current: CoreFrameOutput | null } = { current: null };
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, nextOutput) {
          output.current = nextOutput;
          return { write: () => true, closeInput: vi.fn(), reset: vi.fn() };
        },
      },
      (frame) => emitted.push(frame),
      {
        initialCreditBytes: 4,
        maxCreditBytes: 4,
        maxOutputQueueBytesPerStream: 8,
        maxOutputQueueBytesTotal: 8,
        maxOutputQueueFramesPerStream: 4,
        maxOutputQueueFramesTotal: 4,
        maxFrameBytes: 1024,
      },
    );
    bridge.accept(inbound('fragmented-output', 0, 'open'));

    output.current?.data(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(emitted.filter((frame) => frame.kind === 'data').map((frame) => [...frame.payload]))
      .toEqual([[1, 2, 3, 4]]);
    expect(bridge.queuedOutputBytes()).toBe(2);

    bridge.accept(inbound('fragmented-output', 1, 'credit', { creditBytes: 4 }));
    expect(emitted.filter((frame) => frame.kind === 'data').map((frame) => [...frame.payload]))
      .toEqual([[1, 2, 3, 4], [5, 6]]);
    expect(bridge.queuedOutputBytes()).toBe(0);
  });

  it('rejects wrong generation and out-of-order frames before touching Core', () => {
    const write = vi.fn(() => true);
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open: () => ({ write, closeInput: vi.fn(), reset: vi.fn() }),
      },
      vi.fn(),
    );
    bridge.accept(inbound('stream-a', 0, 'open'));
    expect(() =>
      bridge.accept(inbound('stream-a', 2, 'data', { payload: new Uint8Array([1]) })),
    ).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(bridge.streamCount()).toBe(0);
  });

  it('independently rejects Relay data beyond inbound credit', () => {
    const write = vi.fn(() => true);
    const emitted: RelayRouteFrame[] = [];
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      { open: () => ({ write, closeInput: vi.fn(), reset: vi.fn() }) },
      (frame) => emitted.push(frame),
      {
        initialCreditBytes: 2,
        maxCreditBytes: 4,
        maxOutputQueueBytesPerStream: 8,
        maxOutputQueueBytesTotal: 16,
        maxOutputQueueFramesPerStream: 8,
        maxOutputQueueFramesTotal: 16,
        maxFrameBytes: 1024,
      },
    );
    bridge.accept(inbound('credit-violation', 0, 'open'));
    bridge.accept(
      inbound('credit-violation', 1, 'data', { payload: new Uint8Array([1, 2, 3]) }),
    );

    expect(write).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ kind: 'reset', resetCode: 'protocol_error' }),
    );
    expect(bridge.streamCount()).toBe(0);
  });

  it('rejects an in-memory route body above negotiated maxFrameBytes before Core write', () => {
    const write = vi.fn(() => true);
    const data = inbound('frame-limit', 1, 'data', { payload: new Uint8Array(1_024) });
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      { open: () => ({ write, closeInput: vi.fn(), reset: vi.fn() }) },
      vi.fn(),
      {
        initialCreditBytes: 2_048,
        maxCreditBytes: 2_048,
        maxOutputQueueBytesPerStream: 2_048,
        maxOutputQueueBytesTotal: 2_048,
        maxOutputQueueFramesPerStream: 4,
        maxOutputQueueFramesTotal: 4,
        maxFrameBytes: 512,
      },
    );
    bridge.accept(inbound('frame-limit', 0, 'open'));

    expect(() => bridge.accept(data)).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
    expect(write).not.toHaveBeenCalled();
    expect(bridge.streamCount()).toBe(1);
  });

  it('rejects data and duplicate close after Core input is closed', () => {
    const closeInput = vi.fn();
    const emitted: RelayRouteFrame[] = [];
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      { open: () => ({ write: () => true, closeInput, reset: vi.fn() }) },
      (frame) => emitted.push(frame),
    );
    bridge.accept(inbound('closed-input', 0, 'open'));
    bridge.accept(inbound('closed-input', 1, 'close'));
    bridge.accept(
      inbound('closed-input', 2, 'data', { payload: new Uint8Array([1]) }),
    );
    expect(closeInput).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ kind: 'reset', resetCode: 'protocol_error' }),
    );

    bridge.accept(inbound('duplicate-close', 0, 'open'));
    bridge.accept(inbound('duplicate-close', 1, 'close'));
    bridge.accept(inbound('duplicate-close', 2, 'close'));
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ streamId: 'duplicate-close', kind: 'reset' }),
    );
  });

  it('bounds tiny output objects independently of queued payload bytes', () => {
    const output: { current: CoreFrameOutput | null } = { current: null };
    const reset = vi.fn();
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, nextOutput) {
          output.current = nextOutput;
          return { write: () => true, closeInput: vi.fn(), reset };
        },
      },
      vi.fn(),
      {
        initialCreditBytes: 1,
        maxCreditBytes: 1,
        maxOutputQueueBytesPerStream: 100,
        maxOutputQueueBytesTotal: 100,
        maxOutputQueueFramesPerStream: 2,
        maxOutputQueueFramesTotal: 3,
        maxFrameBytes: 1024,
      },
    );
    bridge.accept(inbound('tiny-stream', 0, 'open'));
    output.current?.data(new Uint8Array([1]));
    output.current?.data(new Uint8Array([2]));
    output.current?.data(new Uint8Array([3]));
    output.current?.data(new Uint8Array([4]));

    expect(reset).toHaveBeenCalledWith('backpressure');
    expect(bridge.queuedOutputBytes()).toBe(0);
    expect(bridge.queuedOutputFrames()).toBe(0);
    expect(bridge.streamCount()).toBe(0);
  });

  it('enforces the total tiny-frame cap without dropping another stream', () => {
    const outputs = new Map<string, CoreFrameOutput>();
    const resetA = vi.fn();
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(streamId, output) {
          outputs.set(streamId, output);
          return {
            write: () => true,
            closeInput: vi.fn(),
            reset: streamId === 'stream-a' ? resetA : vi.fn(),
          };
        },
      },
      vi.fn(),
      {
        initialCreditBytes: 1,
        maxCreditBytes: 1,
        maxOutputQueueBytesPerStream: 100,
        maxOutputQueueBytesTotal: 100,
        maxOutputQueueFramesPerStream: 2,
        maxOutputQueueFramesTotal: 2,
        maxFrameBytes: 1024,
      },
    );
    bridge.accept(inbound('stream-a', 0, 'open'));
    bridge.accept(inbound('stream-b', 0, 'open'));
    outputs.get('stream-a')?.data(new Uint8Array([1]));
    outputs.get('stream-b')?.data(new Uint8Array([1]));
    outputs.get('stream-a')?.data(new Uint8Array([2]));
    outputs.get('stream-b')?.data(new Uint8Array([2]));
    outputs.get('stream-a')?.data(new Uint8Array([3]));

    expect(resetA).toHaveBeenCalledWith('backpressure');
    expect(bridge.streamCount()).toBe(1);
    expect(bridge.queuedOutputFrames()).toBe(1);
    bridge.dispose();
    expect(bridge.queuedOutputFrames()).toBe(0);
  });

  it('contains channel and emit callback failures to the affected stream', () => {
    const outputs = new Map<string, CoreFrameOutput>();
    const resets = new Map<string, ReturnType<typeof vi.fn>>();
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(streamId, output) {
          outputs.set(streamId, output);
          const reset = vi.fn(() => {
            if (streamId === 'stream-a') throw new Error('reset failed');
          });
          resets.set(streamId, reset);
          return {
            write: () => true,
            closeInput: () => {
              throw new Error('close failed');
            },
            reset,
          };
        },
      },
      (frame) => {
        if (frame.streamId === 'stream-a' && frame.kind === 'data') {
          throw new Error('emit failed');
        }
      },
    );
    bridge.accept(inbound('stream-a', 0, 'open'));
    bridge.accept(inbound('stream-b', 0, 'open'));
    outputs.get('stream-a')?.data(new Uint8Array([1]));
    expect(bridge.streamCount()).toBe(1);
    expect(bridge.queuedOutputBytes()).toBeGreaterThanOrEqual(0);
    expect(bridge.queuedOutputFrames()).toBeGreaterThanOrEqual(0);

    bridge.accept(inbound('stream-b', 1, 'close'));
    expect(resets.get('stream-b')).toHaveBeenCalledWith('protocol_error');
    expect(bridge.streamCount()).toBe(0);
  });

  it('validates streamId and cleans up when channel construction throws', () => {
    const open = vi.fn(() => {
      throw new Error('open failed');
    });
    const bridge = new LocalWorkerFrameBridge('instance-a', 3, { open }, vi.fn());
    expect(() => bridge.accept(inbound('invalid stream id', 0, 'open'))).toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(bridge.streamCount()).toBe(0);

    expect(() => bridge.accept(inbound('stream-a', 0, 'open'))).not.toThrow();
    expect(bridge.streamCount()).toBe(0);
    expect(bridge.queuedOutputBytes()).toBe(0);
    expect(bridge.queuedOutputFrames()).toBe(0);
  });

  it('does not emit orphan credit when Core synchronously terminates during write', () => {
    const emitted: RelayRouteFrame[] = [];
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, output) {
          return {
            write() {
              output.reset('cancelled');
              return true;
            },
            closeInput: vi.fn(),
            reset: vi.fn(),
          };
        },
      },
      (frame) => emitted.push(frame),
    );

    bridge.accept(inbound('synchronous-reset', 0, 'open'));
    bridge.accept(
      inbound('synchronous-reset', 1, 'data', { payload: new Uint8Array([1]) }),
    );

    expect(emitted.map((frame) => frame.kind)).toEqual(['reset']);
    expect(bridge.streamCount()).toBe(0);
    expect(bridge.queuedOutputBytes()).toBe(0);
  });

  it('ignores a stale Core callback after its stream id is reused', () => {
    const outputs: CoreFrameOutput[] = [];
    const emitted: RelayRouteFrame[] = [];
    const bridge = new LocalWorkerFrameBridge(
      'instance-a',
      3,
      {
        open(_streamId, output) {
          outputs.push(output);
          return { write: () => true, closeInput: vi.fn(), reset: vi.fn() };
        },
      },
      (frame) => emitted.push(frame),
    );
    bridge.accept(inbound('reused-stream', 0, 'open'));
    bridge.accept(inbound('reused-stream', 1, 'reset', { resetCode: 'cancelled' }));
    bridge.accept(inbound('reused-stream', 0, 'open'));
    const emittedBeforeStaleClose = emitted.length;

    outputs[0].close();
    expect(emitted).toHaveLength(emittedBeforeStaleClose);
    expect(bridge.streamCount()).toBe(1);
  });
});
