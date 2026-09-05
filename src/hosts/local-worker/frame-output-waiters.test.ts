import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';
import type { RelayRouteFrame } from '@protocol/relay';
import { LocalWorkerFrameBridge, type CoreFrameOutput } from './frame-bridge';

function fixture() {
  const outputs: CoreFrameOutput[] = [];
  const emitted: RelayRouteFrame[] = [];
  const bridge = new LocalWorkerFrameBridge('instance', 1, {
    open(_id, output) {
      outputs.push(output);
      return { write: () => true, closeInput: vi.fn(), reset: vi.fn() };
    },
  }, (frame) => emitted.push(frame), {
    initialCreditBytes: 4, maxCreditBytes: 4, maxOutputQueueBytesPerStream: 2,
    maxOutputQueueBytesTotal: 2, maxOutputQueueFramesPerStream: 1,
    maxOutputQueueFramesTotal: 1, maxFrameBytes: 1_024,
  });
  const accept = (streamId: string, kind: RelayRouteFrame['kind'], sequence: number, creditBytes: number | null = null) => bridge.accept({
    instanceId: 'instance', generation: 1, streamId, direction: 'client-to-worker', sequence,
    kind, payload: new Uint8Array(), creditBytes, resetCode: kind === 'reset' ? 'cancelled' : null,
    connectionScope: kind === 'open' ? 'scope' : null,
    accessSurface: kind === 'open' ? 'desktop' : null,
    accessGrant: kind === 'open' ? issueRemoteOwnerGrantClaim('desktop') : null,
  });
  return { bridge, outputs, emitted, accept };
}

const chunk = new Uint8Array([1, 2]);

async function exhaust(output: CoreFrameOutput) {
  expect(output.maxChunkBytes).toBe(2); // Progress also works when a queue is smaller than initial credit.
  await output.data(chunk);
  await output.data(chunk);
  await output.data(chunk);
}

describe('bounded Worker output admission waiters', () => {
  it('waits for shared byte/frame capacity and completes close after the pending chunk drains', async () => {
    const f = fixture();
    try {
      f.accept('a', 'open', 0);
      f.accept('b', 'open', 0);
      await exhaust(f.outputs[0]);
      await f.outputs[1].data(chunk);
      await f.outputs[1].data(chunk);
      const admitted = vi.fn();
      const pending = f.outputs[1].data(chunk).then((value) => { admitted(value); return value; });
      f.outputs[1].close();
      await Promise.resolve();
      expect(admitted).not.toHaveBeenCalled();
      expect(f.bridge.queuedOutputBytes()).toBe(2);
      expect(f.bridge.queuedOutputFrames()).toBe(1);
      expect(f.emitted.some((frame) => frame.kind === 'close' || frame.kind === 'reset')).toBe(false);

      f.accept('a', 'reset', 1);
      await expect(pending).resolves.toBe(true);
      expect(f.bridge.streamCount()).toBe(1);
      expect(f.bridge.queuedOutputBytes()).toBe(2);
      f.accept('b', 'credit', 1, 2);
      expect(f.emitted.at(-1)).toMatchObject({ streamId: 'b', kind: 'close' });
      expect(f.bridge.streamCount()).toBe(0);
      expect(f.bridge.queuedOutputFrames()).toBe(0);
    } finally { f.bridge.dispose(); }
  });

  it('settles reset/dispose waiters and fences callbacks from a reused stream identity', async () => {
    const f = fixture();
    try {
      f.accept('a', 'open', 0);
      await exhaust(f.outputs[0]);
      const cancelled = f.outputs[0].data(chunk);
      f.accept('a', 'reset', 1);
      f.accept('a', 'open', 0);
      await expect(cancelled).resolves.toBe(false);
      f.outputs[0].close();
      await expect(f.outputs[0].data(chunk)).resolves.toBe(false);
      expect(f.bridge.streamCount()).toBe(1);
      await exhaust(f.outputs[1]);
      const disposed = f.outputs[1].data(chunk);
      f.bridge.dispose();
      await expect(disposed).resolves.toBe(false);
      expect(f.bridge.queuedOutputBytes()).toBe(0);
      expect(f.bridge.queuedOutputFrames()).toBe(0);
      expect(f.emitted.filter((frame) => frame.kind === 'data').map((frame) => frame.sequence)).toEqual([0, 1, 0, 1]);
    } finally { f.bridge.dispose(); }
  });
});
