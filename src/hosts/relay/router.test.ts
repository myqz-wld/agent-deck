import { describe, expect, it } from 'vitest';

import type { WorkerAttachRequest } from '@protocol/relay';
import { RelayMetadataStore } from './metadata';
import {
  emptyRoutePayload,
  type RelayFrameKind,
  type RelayResetCode,
  type RelayRouteFrame,
} from '@protocol/relay';
import {
  DEFAULT_RELAY_ROUTER_LIMITS,
  RelayRouterError,
  RelayStreamRouter,
  type RelayRouterLimits,
} from './router';

function limits(overrides: Partial<RelayRouterLimits> = {}): RelayRouterLimits {
  return {
    ...DEFAULT_RELAY_ROUTER_LIMITS,
    maxFrameBytes: 4096,
    initialCreditBytes: 1024,
    maxCreditBytes: 1024,
    maxQueueBytesPerStream: 1024,
    maxQueueBytesPerClient: 4096,
    maxQueueBytesToWorker: 4096,
    heartbeatTimeoutMs: 30,
    ...overrides,
  };
}

function attach(
  mode: WorkerAttachRequest['mode'] = 'register',
  generation: number | null = null,
  expectedGeneration: number | null = null,
  workerId = 'worker-a',
  credentialId = 'worker-credential-a',
): WorkerAttachRequest {
  return {
    type: 'attach',
    instanceId: 'instance-a',
    workerId,
    credentialId,
    mode,
    generation,
    expectedGeneration,
  };
}

function frame(
  direction: RelayRouteFrame['direction'],
  generation: number,
  streamId: string,
  sequence: number,
  kind: RelayFrameKind,
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
    direction,
    sequence,
    kind,
    payload: options.payload ?? emptyRoutePayload(),
    creditBytes: options.creditBytes ?? null,
    resetCode: options.resetCode ?? null,
    accessCredentialId: null,
    accessSurface: null,
  };
}

function seedCredential(
  store: RelayMetadataStore,
  credentialId: string,
  kind: 'relay-worker' | 'ssh-client' = 'ssh-client',
): void {
  store.put('credentials', {
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

function seededStore(): RelayMetadataStore {
  const store = new RelayMetadataStore();
  store.put('instances', {
    id: 'instance-a',
    instanceId: 'instance-a',
    topology: 'relay',
    createdAt: 0,
  });
  for (const id of ['worker-credential-a', 'worker-credential-b', 'worker-credential-c']) {
    seedCredential(store, id, 'relay-worker');
  }
  for (const id of ['credential-a', 'credential-b']) seedCredential(store, id);
  return store;
}

function onlineRouter(routerLimits = limits()): RelayStreamRouter {
  const router = new RelayStreamRouter(
    'instance-a',
    seededStore(),
    routerLimits,
    0,
  );
  expect(router.attachWorker(attach(), 'connection-1', 1)).toEqual(
    expect.objectContaining({ accepted: true }),
  );
  return router;
}

describe('Relay single-generation stream router', () => {
  it('enforces exact attach fields and returns the actual negotiated route limits', () => {
    const routerLimits = limits({
      initialCreditBytes: 512,
      maxCreditBytes: 2048,
      maxFrameBytes: 8192,
    });
    const router = new RelayStreamRouter('instance-a', seededStore(), routerLimits, 0);
    expect(router.attachWorker(attach('register', null, 0), 'invalid-register', 1)).toEqual(
      expect.objectContaining({
        accepted: false,
        rejected: expect.objectContaining({ code: 'invalid_attach' }),
      }),
    );
    expect(
      router.attachWorker(
        attach('takeover', null, Number.MAX_SAFE_INTEGER),
        'overflow-takeover',
        1,
      ),
    ).toEqual(
      expect.objectContaining({
        accepted: false,
        rejected: expect.objectContaining({ code: 'invalid_attach' }),
      }),
    );
    expect(router.attachWorker(attach(), 'connection-1', 2)).toEqual(
      expect.objectContaining({
        accepted: true,
        attached: expect.objectContaining({
          initialCreditBytes: 512,
          maxCreditBytes: 2048,
          maxFrameBytes: 8192,
        }),
      }),
    );
  });

  it('routes two clients independently through one active Worker', () => {
    const router = onlineRouter();
    router.registerClient('client-a', 'credential-a');
    router.registerClient('client-b', 'credential-b');
    expect(
      router.routeFromClient('client-a', frame('client-to-worker', 1, 'stream-a', 0, 'open')),
    ).toEqual({ accepted: true, error: null });
    expect(
      router.routeFromClient('client-b', frame('client-to-worker', 1, 'stream-b', 0, 'open')),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainWorker()?.frames.map((item) => item.streamId)).toEqual([
      'stream-a',
      'stream-b',
    ]);

    router.routeFromWorker(
      'connection-1',
      frame('worker-to-client', 1, 'stream-b', 0, 'data', {
        payload: new TextEncoder().encode('b'),
      }),
      2,
    );
    router.routeFromWorker(
      'connection-1',
      frame('worker-to-client', 1, 'stream-a', 0, 'data', {
        payload: new TextEncoder().encode('a'),
      }),
      2,
    );

    expect(new TextDecoder().decode(router.drainClient('client-a')[0].payload)).toBe('a');
    expect(new TextDecoder().decode(router.drainClient('client-b')[0].payload)).toBe('b');
    expect(router.streamCount()).toBe(2);
  });

  it('fails every Core stream explicitly while the Worker is offline and queues no mutation', () => {
    const metadata = seededStore();
    const router = new RelayStreamRouter('instance-a', metadata, limits(), 0);
    router.registerClient('client-a', 'credential-a');

    expect(
      router.routeFromClient('client-a', frame('client-to-worker', 0, 'offline-stream', 0, 'open')),
    ).toEqual({ accepted: false, error: 'worker_offline' });
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ kind: 'reset', resetCode: 'worker_offline' }),
    ]);
    expect(router.queuedBytesToWorker()).toBe(0);
    expect(router.streamCount()).toBe(0);
    expect(metadata.rows('routes')).toEqual([]);
    expect(metadata.exportSnapshot()).not.toContain('offline-stream');
  });

  it('uses generation CAS for takeover, fences the old connection, and rejects the race loser', () => {
    const router = onlineRouter();
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'in-flight', 0, 'open'));
    router.drainWorker();

    const winner = router.attachWorker(
      attach('takeover', null, 1, 'worker-b', 'worker-credential-b'),
      'connection-2',
      10,
    );
    expect(winner).toEqual(
      expect.objectContaining({
        accepted: true,
        attached: expect.objectContaining({ generation: 2, workerId: 'worker-b' }),
        fencedConnectionId: 'connection-1',
      }),
    );
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({
        generation: 1,
        streamId: 'in-flight',
        kind: 'reset',
        resetCode: 'worker_fenced',
      }),
    ]);
    expect(() =>
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 1, 'in-flight', 0, 'data', {
          payload: new Uint8Array([1]),
        }),
      ),
    ).toThrowError(expect.objectContaining<Partial<RelayRouterError>>({ code: 'worker_fenced' }));

    const loser = router.attachWorker(
      attach('takeover', null, 1, 'worker-c', 'worker-credential-c'),
      'connection-3',
      11,
    );
    expect(loser).toEqual(
      expect.objectContaining({
        accepted: false,
        rejected: expect.objectContaining({
          code: 'generation_conflict',
          currentGeneration: 2,
        }),
      }),
    );
    expect(router.status()).toEqual(expect.objectContaining({ generation: 2, online: true }));
  });

  it('reconnects the same identity at the same generation and rejects identity substitution', () => {
    const router = onlineRouter();
    expect(router.attachWorker(attach(), 'connection-duplicate', 9)).toEqual(
      expect.objectContaining({
        accepted: false,
        rejected: expect.objectContaining({ code: 'worker_already_registered' }),
      }),
    );
    router.detachWorker('connection-1', 10);
    expect(router.status()).toEqual(expect.objectContaining({ generation: 1, online: false }));
    const wrong = router.attachWorker(
      attach('reconnect', 1, null, 'worker-b', 'worker-credential-a'),
      'connection-2',
      11,
    );
    expect(wrong).toEqual(
      expect.objectContaining({
        accepted: false,
        rejected: expect.objectContaining({ code: 'credential_mismatch' }),
      }),
    );
    const resumed = router.attachWorker(
      attach('reconnect', 1),
      'connection-2',
      12,
    );
    expect(resumed).toEqual(
      expect.objectContaining({
        accepted: true,
        resumedGeneration: true,
        attached: expect.objectContaining({ generation: 1 }),
      }),
    );
  });

  it('fences an overlapping same-generation reconnect and fails its in-flight streams', () => {
    const router = onlineRouter();
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'reconnect-stream', 0, 'open'));
    router.drainWorker();

    const resumed = router.attachWorker(attach('reconnect', 1), 'connection-2', 10);
    expect(resumed).toEqual(
      expect.objectContaining({
        accepted: true,
        resumedGeneration: true,
        fencedConnectionId: 'connection-1',
        attached: expect.objectContaining({ generation: 1 }),
      }),
    );
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({
        streamId: 'reconnect-stream',
        resetCode: 'worker_disconnected',
      }),
    ]);
    expect(() =>
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 1, 'reconnect-stream', 0, 'close'),
      ),
    ).toThrowError(expect.objectContaining<Partial<RelayRouterError>>({ code: 'worker_fenced' }));
  });

  it('enforces credit caps and sequence order, then deterministically resets the stream', () => {
    const router = onlineRouter(limits({ initialCreditBytes: 16, maxCreditBytes: 16 }));
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'credit-stream', 0, 'open'));
    router.drainWorker();

    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 1, 'credit-stream', 0, 'credit', { creditBytes: 1 }),
      ),
    ).toEqual({ accepted: false, error: 'protocol_error' });
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ kind: 'reset', resetCode: 'protocol_error' }),
    ]);
    expect(router.streamCount()).toBe(0);
  });

  it('forwards cancellation and removes in-flight stream state', () => {
    const router = onlineRouter();
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'cancel-stream', 0, 'open'));
    router.drainWorker();
    expect(
      router.routeFromClient(
        'client-a',
        frame('client-to-worker', 1, 'cancel-stream', 1, 'reset', {
          resetCode: 'cancelled',
        }),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ streamId: 'cancel-stream', resetCode: 'cancelled' }),
    ]);
    expect(router.streamCount()).toBe(0);
  });

  it('validates ordered half-close in both directions', () => {
    const router = onlineRouter();
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'close-stream', 0, 'open'));
    router.drainWorker();
    expect(
      router.routeFromClient(
        'client-a',
        frame('client-to-worker', 1, 'close-stream', 1, 'close'),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ streamId: 'close-stream', kind: 'close', sequence: 1 }),
    ]);
    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 1, 'close-stream', 0, 'data', {
          payload: new Uint8Array([1]),
        }),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ streamId: 'close-stream', kind: 'data', sequence: 0 }),
    ]);
    expect(
      router.routeFromClient(
        'client-a',
        frame('client-to-worker', 1, 'close-stream', 2, 'credit', { creditBytes: 1 }),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ streamId: 'close-stream', kind: 'credit', sequence: 2 }),
    ]);
    expect(
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 1, 'close-stream', 1, 'close'),
      ),
    ).toEqual({ accepted: true, error: null });
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ streamId: 'close-stream', kind: 'close', sequence: 1 }),
    ]);
    expect(router.streamCount()).toBe(0);
  });

  it('expires a silent Worker heartbeat without affecting deterministic reset delivery', () => {
    const router = new RelayStreamRouter(
      'instance-a',
      seededStore(),
      limits({ heartbeatTimeoutMs: 30 }),
      0,
    );
    router.attachWorker(attach(), 'connection-1', 100);
    router.registerClient('client-a', 'credential-a');
    router.routeFromClient('client-a', frame('client-to-worker', 1, 'heartbeat-stream', 0, 'open'));
    router.drainWorker();
    router.routeFromWorker(
      'connection-1',
      frame('worker-to-client', 1, '$lease', 0, 'heartbeat'),
      120,
    );
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ kind: 'heartbeat', direction: 'client-to-worker', sequence: 0 }),
    ]);
    router.tick(150);
    expect(router.status().online).toBe(true);
    router.tick(151);
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ kind: 'reset', resetCode: 'heartbeat_timeout' }),
    ]);
  });

  it('restores registration metadata after Relay restart but never restores an online lease', () => {
    const firstStore = seededStore();
    const first = new RelayStreamRouter('instance-a', firstStore, limits(), 0);
    first.attachWorker(attach(), 'connection-1', 10);
    first.registerClient('client-a', 'credential-a');
    first.routeFromClient('client-a', frame('client-to-worker', 1, 'restart-stream', 0, 'open'));
    first.drainWorker();
    const restoredStore = RelayMetadataStore.fromSnapshot(firstStore.exportSnapshot());
    const restarted = new RelayStreamRouter('instance-a', restoredStore, limits(), 20);

    expect(restarted.status()).toEqual(
      expect.objectContaining({ generation: 1, online: false, connectionId: null }),
    );
    const resumed = restarted.attachWorker(attach('reconnect', 1), 'connection-2', 21);
    expect(resumed).toEqual(
      expect.objectContaining({
        accepted: true,
        resumedGeneration: true,
        attached: expect.objectContaining({ generation: 1 }),
      }),
    );
    expect(restoredStore.rows('routes')).toEqual([
      expect.objectContaining({ routeId: 'restart-stream', status: 'fenced', updatedAt: 20 }),
    ]);
  });
});
