import { describe, expect, it } from 'vitest';

import { RelayMetadataStore } from './metadata';
import {
  emptyRoutePayload,
  encodeRelayRouteFrame,
  RelayRouteFrameError,
  type RelayRouteFrame,
} from '@protocol/relay';
import { DEFAULT_RELAY_ROUTER_LIMITS, RelayStreamRouter } from './router';

function frame(kind: 'open' | 'data', sequence: number, payload = emptyRoutePayload()): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 1,
    streamId: 'bounded-stream',
    direction: 'client-to-worker',
    sequence,
    kind,
    payload,
    creditBytes: null,
    resetCode: null,
    accessCredentialId: null,
    accessSurface: null,
  };
}

function metadata(): RelayMetadataStore {
  const store = new RelayMetadataStore();
  store.put('instances', {
    id: 'instance-a',
    instanceId: 'instance-a',
    topology: 'relay',
    createdAt: 0,
  });
  for (const [credentialId, kind] of [
    ['worker-credential', 'relay-worker'],
    ['client-credential', 'ssh-client'],
  ] as const) {
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
  return store;
}

describe('Relay negotiated in-memory route limit', () => {
  it('rejects a complete route body above maxFrameBytes before mutating stream state', () => {
    const data = frame('data', 1, new Uint8Array(512));
    const exactBodyBytes = encodeRelayRouteFrame(data).byteLength - 4;
    const router = new RelayStreamRouter('instance-a', metadata(), {
      ...DEFAULT_RELAY_ROUTER_LIMITS,
      maxFrameBytes: exactBodyBytes - 1,
      initialCreditBytes: 1024,
      maxCreditBytes: 1024,
    });
    expect(
      router.attachWorker(
        {
          type: 'attach',
          instanceId: 'instance-a',
          workerId: 'worker-a',
          credentialId: 'worker-credential',
          mode: 'register',
          generation: null,
          expectedGeneration: null,
        },
        'connection-a',
        1,
      ).accepted,
    ).toBe(true);
    router.registerClient('client-a', 'client-credential');
    expect(router.routeFromClient('client-a', frame('open', 0)).accepted).toBe(true);
    router.drainWorker();

    expect(() => router.routeFromClient('client-a', data)).toThrowError(
      expect.objectContaining<Partial<RelayRouteFrameError>>({ code: 'frame_oversized' }),
    );
    expect(router.streamCount()).toBe(1);
    expect(router.queuedBytesToWorker()).toBe(0);
  });
});
