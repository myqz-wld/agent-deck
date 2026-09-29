import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';
import type { RelayRouteFrame } from '@protocol/relay';
import { LocalWorkerFrameBridge, type CoreFrameOutput } from './frame-bridge';

function frame(streamId: string, kind: RelayRouteFrame['kind'], sequence = 0): RelayRouteFrame {
  return {
    instanceId: 'instance-a', generation: 1, streamId, direction: 'client-to-worker',
    kind, sequence, payload: kind === 'data' ? new Uint8Array([1]) : new Uint8Array(),
    creditBytes: kind === 'credit' ? 1 : null, resetCode: kind === 'reset' ? 'cancelled' : null,
    connectionScope: kind === 'open' ? 'scope-client' : null,
    accessSurface: kind === 'open' ? 'desktop' : null,
    accessGrant: kind === 'open' ? issueRemoteOwnerGrantClaim('desktop') : null,
  };
}

describe('Worker terminal stream isolation', () => {
  it.each([
    { generation: 2 },
    { instanceId: 'other-instance' },
    { direction: 'worker-to-client' },
  ] as const)('does not skip identity checks for a retired stream: %j', (patch) => {
    let output: CoreFrameOutput | undefined;
    const bridge = new LocalWorkerFrameBridge('instance-a', 1, {
      open(_id, next) {
        output = next;
        return { write: () => true, closeInput: () => undefined, reset: () => undefined };
      },
    }, () => undefined);
    try {
      bridge.accept(frame('closed-stream', 'open'));
      output!.close();
      expect(() => bridge.accept({ ...frame('closed-stream', 'credit', 1), ...patch })).toThrow();
    } finally { bridge.dispose(); }
  });

  it.each(['credit', 'data', 'close', 'reset'] as const)('ignores late %s after Core closes without breaking another stream', (kind) => {
    const outputs = new Map<string, CoreFrameOutput>();
    const write = vi.fn(() => true);
    const bridge = new LocalWorkerFrameBridge('instance-a', 1, {
      open(id, output) {
        outputs.set(id, output);
        return { write, closeInput: () => undefined, reset: () => undefined };
      },
    }, () => undefined);
    try {
      bridge.accept(frame('closed-stream', 'open'));
      bridge.accept(frame('live-stream', 'open'));
      outputs.get('closed-stream')!.close();
      expect(() => bridge.accept(frame('closed-stream', kind, 1))).not.toThrow();
      bridge.accept(frame('live-stream', 'data', 1));
      expect(write).toHaveBeenCalledOnce();
    } finally {
      bridge.dispose();
    }
  });
});
