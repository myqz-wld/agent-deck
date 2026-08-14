import { describe, expect, it } from 'vitest';

import type { WorkerAttachRequest } from '@protocol/relay';
import { RelayMetadataStore } from './metadata';
import {
  emptyRoutePayload,
  relayRouteFrameWireBytes,
  type RelayFrameKind,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';
import {
  DEFAULT_RELAY_ROUTER_LIMITS,
  RelayStreamRouter,
  type RelayRouterLimits,
} from './router';

function limits(overrides: Partial<RelayRouterLimits> = {}): RelayRouterLimits {
  return {
    ...DEFAULT_RELAY_ROUTER_LIMITS,
    maxFrameBytes: 4096,
    initialCreditBytes: 4096,
    maxCreditBytes: 4096,
    maxQueueBytesPerStream: 4096,
    maxQueueBytesPerClient: 4096,
    maxQueueBytesToWorker: 4096,
    heartbeatTimeoutMs: 30,
    ...overrides,
  };
}

function frame(
  direction: RelayRouteFrame['direction'],
  streamId: string,
  sequence: number,
  kind: RelayFrameKind,
  options: { payload?: Uint8Array; resetCode?: RelayResetCode | null } = {},
): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 1,
    streamId,
    direction,
    sequence,
    kind,
    payload: options.payload ?? emptyRoutePayload(),
    creditBytes: null,
    resetCode: options.resetCode ?? null,
    connectionScope: null,
    accessSurface: null,
    accessGrant: null,
  };
}

function onlineRouter(routerLimits: RelayRouterLimits): RelayStreamRouter {
  const metadata = new RelayMetadataStore();
  metadata.put('instances', {
    id: 'instance-a',
    instanceId: 'instance-a',
    topology: 'relay',
    createdAt: 0,
  });
  for (const [credentialId, kind] of [
    ['worker-credential-a', 'relay-worker'],
    ['credential-a', 'ssh-client'],
    ['credential-slow', 'ssh-client'],
    ['credential-fast', 'ssh-client'],
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
  const router = new RelayStreamRouter('instance-a', metadata, routerLimits, 0);
  const request: WorkerAttachRequest = {
    type: 'attach',
    instanceId: 'instance-a',
    workerId: 'worker-a',
    credentialId: 'worker-credential-a',
    mode: 'register',
    generation: null,
    expectedGeneration: null,
  };
  expect(router.attachWorker(request, 'connection-1', 1).accepted).toBe(true);
  return router;
}

describe('Relay hard queue bounds', () => {
  it('disconnects only the slow client when its per-stream queue is full', () => {
    const payload = new Uint8Array(512).fill(7);
    const sample = frame('worker-to-client', 'slow-stream', 0, 'data', { payload });
    const wireBytes = relayRouteFrameWireBytes(sample, { maxFrameBytes: 4096 });
    const router = onlineRouter(
      limits({
        maxQueueBytesPerStream: wireBytes + 8,
        maxQueueBytesPerClient: wireBytes * 4,
        maxQueueBytesToWorker: wireBytes * 4,
      }),
    );
    router.registerClient('slow-client', 'credential-slow');
    router.registerClient('fast-client', 'credential-fast');
    router.routeFromClient('slow-client', frame('client-to-worker', 'slow-stream', 0, 'open'));
    router.routeFromClient('fast-client', frame('client-to-worker', 'fast-stream', 0, 'open'));
    router.drainWorker();

    expect(router.routeFromWorker('connection-1', sample)).toEqual({ accepted: true, error: null });
    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 'slow-stream', 1, 'data', { payload }),
      ),
    ).toEqual({ accepted: false, error: 'resync_required' });
    expect(router.takeClientDisconnects()).toContainEqual({
      clientId: 'slow-client',
      reason: 'resync_required',
    });
    expect(router.drainClient('slow-client')).toEqual([]);
    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 'fast-stream', 0, 'data', { payload }),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainClient('fast-client')).toEqual([
      expect.objectContaining({ streamId: 'fast-stream', kind: 'data' }),
    ]);
    expect(router.streamCount()).toBe(1);
  });

  it.each(['close', 'reset'] as const)(
    'requires resync when another stream leaves no room for terminal %s',
    (terminalKind) => {
      const payload = new Uint8Array(512).fill(9);
      const filler = frame('worker-to-client', 'filler-stream', 0, 'data', { payload });
      const fillerBytes = relayRouteFrameWireBytes(filler, { maxFrameBytes: 4096 });
      const terminal = frame(
        'worker-to-client',
        'target-stream',
        0,
        terminalKind,
        terminalKind === 'reset' ? { resetCode: 'cancelled' } : {},
      );
      expect(relayRouteFrameWireBytes(terminal, { maxFrameBytes: 4096 })).toBeLessThan(
        fillerBytes,
      );
      const router = onlineRouter(
        limits({
          maxQueueBytesPerStream: fillerBytes,
          maxQueueBytesPerClient: fillerBytes,
        }),
      );
      router.registerClient('client-a', 'credential-a');
      router.routeFromClient('client-a', frame('client-to-worker', 'target-stream', 0, 'open'));
      router.routeFromClient('client-a', frame('client-to-worker', 'filler-stream', 0, 'open'));
      router.drainWorker();
      expect(router.routeFromWorker('connection-1', filler).accepted).toBe(true);

      expect(router.routeFromWorker('connection-1', terminal)).toEqual({
        accepted: false,
        error: 'resync_required',
      });
      expect(router.takeClientDisconnects()).toEqual([
        { clientId: 'client-a', reason: 'resync_required' },
      ]);
      expect(router.drainClient('client-a')).toEqual([]);
      expect(router.streamCount()).toBe(0);
    },
  );

  it('requires resync when failStream cannot queue its generated client reset', () => {
    const payload = new Uint8Array(512).fill(6);
    const filler = frame('worker-to-client', 'filler-stream', 0, 'data', { payload });
    const fillerBytes = relayRouteFrameWireBytes(filler, { maxFrameBytes: 4096 });
    const router = onlineRouter(
      limits({
        maxQueueBytesPerStream: fillerBytes,
        maxQueueBytesPerClient: fillerBytes,
      }),
    );
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 'target-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromClient('client-a', frame('client-to-worker', 'filler-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromWorker('connection-1', filler);

    const excessiveCredit: RelayRouteFrame = {
      ...frame('worker-to-client', 'target-stream', 0, 'credit'),
      creditBytes: 1,
    };
    expect(router.routeFromWorker('connection-1', excessiveCredit)).toEqual({
      accepted: false,
      error: 'resync_required',
    });
    expect(router.takeClientDisconnects()).toEqual([
      { clientId: 'client-a', reason: 'resync_required' },
    ]);
    expect(router.drainClient('client-a')).toEqual([]);
    expect(router.streamCount()).toBe(0);
  });

  it('fences the Worker when a client reset cannot enter its queue', () => {
    const payload = new Uint8Array(512).fill(3);
    const filler = frame('client-to-worker', 'filler-stream', 1, 'data', { payload });
    const fillerBytes = relayRouteFrameWireBytes(filler, { maxFrameBytes: 4096 });
    const router = onlineRouter(
      limits({
        maxQueueBytesPerStream: fillerBytes,
        maxQueueBytesToWorker: fillerBytes,
      }),
    );
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 'target-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromClient('client-a', frame('client-to-worker', 'filler-stream', 0, 'open'));
    router.drainWorker();
    expect(router.routeFromClient('client-a', filler).accepted).toBe(true);

    expect(
      router.routeFromClient(
        'client-a',
        frame('client-to-worker', 'target-stream', 1, 'reset', { resetCode: 'cancelled' }),
      ),
    ).toEqual({ accepted: false, error: 'worker_disconnected' });
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ streamId: 'filler-stream', resetCode: 'worker_disconnected' }),
    ]);
    expect(router.streamCount()).toBe(0);
  });

  it('fences the Worker when a generated failure reset cannot enter its queue', () => {
    const payload = new Uint8Array(512).fill(5);
    const filler = frame('client-to-worker', 'filler-stream', 1, 'data', { payload });
    const fillerBytes = relayRouteFrameWireBytes(filler, { maxFrameBytes: 4096 });
    const router = onlineRouter(
      limits({
        maxQueueBytesPerStream: fillerBytes,
        maxQueueBytesToWorker: fillerBytes,
      }),
    );
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 'target-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromClient('client-a', frame('client-to-worker', 'filler-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromClient('client-a', filler);

    const excessiveCredit: RelayRouteFrame = {
      ...frame('worker-to-client', 'target-stream', 0, 'credit'),
      creditBytes: 1,
    };
    expect(router.routeFromWorker('connection-1', excessiveCredit)).toEqual({
      accepted: false,
      error: 'worker_disconnected',
    });
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ streamId: 'target-stream', resetCode: 'protocol_error' }),
      expect.objectContaining({ streamId: 'filler-stream', resetCode: 'worker_disconnected' }),
    ]);
  });

  it('fences the Worker when a heartbeat acknowledgement cannot be queued', () => {
    const payload = new Uint8Array(512).fill(4);
    const filler = frame('client-to-worker', 'filler-stream', 1, 'data', { payload });
    const fillerBytes = relayRouteFrameWireBytes(filler, { maxFrameBytes: 4096 });
    const router = onlineRouter(
      limits({
        maxQueueBytesPerStream: fillerBytes,
        maxQueueBytesToWorker: fillerBytes,
      }),
    );
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 'filler-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromClient('client-a', filler);

    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', '$lease', 0, 'heartbeat'),
        2,
      ),
    ).toEqual({ accepted: false, error: 'worker_disconnected' });
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.streamCount()).toBe(0);
  });
});
