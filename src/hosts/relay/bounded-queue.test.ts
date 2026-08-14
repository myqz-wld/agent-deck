import { describe, expect, it } from 'vitest';

import { BoundedRelayFrameQueue } from './bounded-queue';
import type { RelayRouteFrame } from '@protocol/relay';

const LIMITS = { maxFrameBytes: 4096, maxCreditBytes: 4096 };

function dataFrame(): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 1,
    streamId: 'stream-a',
    direction: 'client-to-worker',
    sequence: 1,
    kind: 'data',
    payload: new Uint8Array([1, 2, 3]),
    creditBytes: null,
    resetCode: null,
    connectionScope: null,
    accessSurface: null,
    accessGrant: null,
  };
}

function queue(): BoundedRelayFrameQueue {
  return new BoundedRelayFrameQueue(4096, 8192, LIMITS);
}

describe('bounded Relay frame queue isolation', () => {
  it('clones the envelope and payload before retaining caller input', () => {
    const pending = queue();
    const frame = dataFrame();
    expect(pending.enqueue(frame)).toBe(true);
    frame.instanceId = 'mutated-instance';
    frame.streamId = 'mutated-stream';
    frame.payload[0] = 99;

    expect(pending.drain()).toEqual([
      expect.objectContaining({
        instanceId: 'instance-a',
        streamId: 'stream-a',
        payload: new Uint8Array([1, 2, 3]),
      }),
    ]);
    expect(pending.totalBytes).toBe(0);
  });

  it('isolates drained delivery from another queue holding the same input', () => {
    const first = queue();
    const second = queue();
    const frame = dataFrame();
    first.enqueue(frame);
    second.enqueue(frame);

    const delivered = first.drain()[0];
    delivered.instanceId = 'consumer-mutated';
    delivered.payload[1] = 88;

    expect(second.drain()).toEqual([
      expect.objectContaining({
        instanceId: 'instance-a',
        payload: new Uint8Array([1, 2, 3]),
      }),
    ]);
  });
});
