import { describe, expect, it } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';

import {
  encodeWorkerWireMessage,
  workerWireMessageBytes,
  WorkerWireDecoder,
  type WorkerAttachRequest,
} from '@protocol/relay';
import { RelayMetadataStore } from './metadata';
import { emptyRoutePayload, type RelayRouteFrame } from '@protocol/relay';
import { DEFAULT_RELAY_ROUTER_LIMITS, RelayStreamRouter } from './router';
import { RelayWorkerAttachmentPeer } from './worker-attachment-peer';

function attach(workerId = 'worker-a'): WorkerAttachRequest {
  return {
    type: 'attach',
    instanceId: 'instance-a',
    workerId,
    credentialId: 'worker-credential-a',
    mode: 'register',
    generation: null,
    expectedGeneration: null,
  };
}

function peerFixture(): {
  router: RelayStreamRouter;
  peer: RelayWorkerAttachmentPeer;
} {
  const router = new RelayStreamRouter(
    'instance-a',
    new RelayMetadataStore(),
    { ...DEFAULT_RELAY_ROUTER_LIMITS, heartbeatTimeoutMs: 30 },
    0,
  );
  router.metadata.put('credentials', {
    id: 'worker-credential-a',
    instanceId: 'instance-a',
    credentialId: 'worker-credential-a',
    kind: 'relay-worker',
    publicKey: 'ssh-ed25519 AAAATEST worker-a',
    fingerprint: 'SHA256:test',
    status: 'active',
    createdAt: 1,
    revokedAt: null,
  });
  for (const [credentialId, kind] of [
    ['worker-credential-b', 'relay-worker'],
    ['client-credential-a', 'ssh-client'],
  ] as const) {
    router.metadata.put('credentials', {
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
  return {
    router,
    peer: new RelayWorkerAttachmentPeer(router, 'connection-peer', {
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'worker-credential-a',
    }),
  };
}

describe('restricted Worker attachment peer', () => {
  it('requires attach first and carries only framed route traffic afterwards', () => {
    const { peer, router } = peerFixture();
    const encoded = encodeWorkerWireMessage(attach());
    expect(peer.push(encoded.subarray(0, 2), 1)).toEqual([]);
    const response = peer.push(encoded.subarray(2), 1);
    expect(new WorkerWireDecoder().push(response[0])).toEqual([
      expect.objectContaining({ type: 'attached', generation: 1 }),
    ]);
    expect(peer.state()).toBe('attached');
    peer.close(2);
    expect(router.status().online).toBe(false);
  });

  it('rejects a stdin identity that does not match the forced-command mapping', () => {
    const { peer, router } = peerFixture();
    const response = peer.push(encodeWorkerWireMessage(attach('spoofed-worker')), 1);
    expect(new WorkerWireDecoder().push(response[0])).toEqual([
      expect.objectContaining({
        type: 'rejected',
        code: 'credential_mismatch',
        retryable: false,
      }),
    ]);
    expect(router.status().online).toBe(false);
  });

  it('does not let a fenced peer consume delivery for the takeover winner', () => {
    const { peer: oldPeer, router } = peerFixture();
    oldPeer.push(encodeWorkerWireMessage(attach()), 1);
    const newPeer = new RelayWorkerAttachmentPeer(router, 'connection-new', {
      instanceId: 'instance-a',
      workerId: 'worker-b',
      credentialId: 'worker-credential-b',
    });
    newPeer.push(
      encodeWorkerWireMessage({
        ...attach('worker-b'),
        credentialId: 'worker-credential-b',
        mode: 'takeover',
        expectedGeneration: 1,
      }),
      2,
    );
    router.registerClient('client-a', 'client-credential-a');
    const open: RelayRouteFrame = {
      instanceId: 'instance-a',
      generation: 2,
      streamId: 'takeover-stream',
      direction: 'client-to-worker',
      sequence: 0,
      kind: 'open',
      payload: emptyRoutePayload(),
      creditBytes: null,
      resetCode: null,
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
    };
    router.routeFromClient('client-a', open);
    router.routeFromClient('client-a', {
      ...open,
      sequence: 1,
      kind: 'data',
      payload: new Uint8Array([1]),
    });

    expect(oldPeer.drain()).toEqual([]);
    const delivered = newPeer.drain();
    const decoder = new WorkerWireDecoder();
    const authorizedOpen = {
      ...open,
      connectionScope: deriveConnectionScope('instance-a', 'client-credential-a'),
      accessSurface: 'desktop' as const,
      accessGrant: issueRemoteOwnerGrantClaim('desktop'),
    };
    expect(delivered.flatMap((chunk) => decoder.push(chunk))).toEqual([
      { type: 'route', frame: authorizedOpen },
      { type: 'route', frame: { ...open, sequence: 1, kind: 'data', payload: new Uint8Array([1]) } },
    ]);
  });

  it('includes the Worker wire wrapper in the peer drain byte budget', () => {
    const { peer, router } = peerFixture();
    peer.push(encodeWorkerWireMessage(attach()), 1);
    router.registerClient('client-a', 'client-credential-a');
    const open: RelayRouteFrame = {
      instanceId: 'instance-a',
      generation: 1,
      streamId: 'budget-stream',
      direction: 'client-to-worker',
      sequence: 0,
      kind: 'open',
      payload: emptyRoutePayload(),
      creditBytes: null,
      resetCode: null,
      connectionScope: null,
      accessSurface: null,
      accessGrant: null,
    };
    router.routeFromClient('client-a', open);
    const wireBytes = workerWireMessageBytes({
      type: 'route',
      frame: {
        ...open,
        connectionScope: deriveConnectionScope('instance-a', 'client-credential-a'),
        accessSurface: 'desktop',
        accessGrant: issueRemoteOwnerGrantClaim('desktop'),
      },
    });
    expect(peer.drain(wireBytes - 1)).toEqual([]);
    expect(peer.drain(wireBytes)).toHaveLength(1);
  });
});
