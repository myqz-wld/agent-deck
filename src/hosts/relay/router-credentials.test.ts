import { describe, expect, it } from 'vitest';

import { RelayMetadataStore, type CredentialMetadata } from './metadata';
import { emptyRoutePayload, type RelayRouteFrame } from '@protocol/relay';
import { RelayRouterError, RelayStreamRouter } from './router';

function credential(
  credentialId: string,
  kind: CredentialMetadata['kind'],
): CredentialMetadata {
  return {
    id: credentialId,
    instanceId: 'instance-a',
    credentialId,
    kind,
    publicKey: kind === 'feishu' ? null : 'ssh-ed25519 AAAATEST',
    fingerprint: `SHA256:${credentialId}`,
    status: 'active',
    createdAt: 1,
    revokedAt: null,
  };
}

function frame(
  direction: RelayRouteFrame['direction'],
  streamId: string,
  sequence: number,
  kind: RelayRouteFrame['kind'],
): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation: 1,
    streamId,
    direction,
    sequence,
    kind,
    payload: kind === 'data' ? new Uint8Array([7]) : emptyRoutePayload(),
    creditBytes: null,
    resetCode: null,
    accessCredentialId: null,
    accessSurface: null,
  };
}

function onlineFixture(): {
  metadata: RelayMetadataStore;
  router: RelayStreamRouter;
} {
  const metadata = new RelayMetadataStore();
  metadata.put('instances', {
    id: 'instance-a',
    instanceId: 'instance-a',
    topology: 'relay',
    createdAt: 0,
  });
  metadata.put('credentials', credential('worker-credential-a', 'relay-worker'));
  metadata.put('credentials', credential('client-credential-a', 'ssh-client'));
  const router = new RelayStreamRouter('instance-a', metadata, undefined, 0);
  expect(
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
    ).accepted,
  ).toBe(true);
  router.registerClient('client-a', 'client-credential-a');
  return { metadata, router };
}

function revoke(metadata: RelayMetadataStore, credentialId: string): void {
  const current = metadata.credential(credentialId);
  expect(current).not.toBeNull();
  metadata.put('credentials', { ...current, status: 'revoked', revokedAt: 2 });
}

describe('Relay live credential enforcement', () => {
  it('fences a revoked Worker before it can route another business frame', () => {
    const { metadata, router } = onlineFixture();
    router.routeFromClient(
      'client-a',
      frame('client-to-worker', 'worker-revoked-route', 0, 'open'),
    );
    router.drainWorker();
    revoke(metadata, 'worker-credential-a');

    expect(() =>
      router.routeFromWorker(
        'connection-1',
        frame('worker-to-client', 'worker-revoked-route', 0, 'data'),
        3,
      ),
    ).toThrowError(expect.objectContaining<Partial<RelayRouterError>>({ code: 'worker_fenced' }));
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
    expect(router.drainClient('client-a')).toEqual([
      expect.objectContaining({ resetCode: 'worker_disconnected' }),
    ]);
  });

  it('fences a revoked Worker before queued delivery', () => {
    const { metadata, router } = onlineFixture();
    router.routeFromClient(
      'client-a',
      frame('client-to-worker', 'worker-revoked-drain', 0, 'open'),
    );
    revoke(metadata, 'worker-credential-a');
    expect(router.drainWorkerFor('connection-1')).toBeNull();
    expect(router.queuedBytesToWorker()).toBe(0);
  });

  it('fences a revoked Worker before accepting its next heartbeat', () => {
    const { metadata, router } = onlineFixture();
    revoke(metadata, 'worker-credential-a');
    expect(() =>
      router.routeFromWorker('connection-1', {
        ...frame('worker-to-client', '$lease', 0, 'heartbeat'),
        payload: emptyRoutePayload(),
      }),
    ).toThrowError(expect.objectContaining<Partial<RelayRouterError>>({ code: 'worker_fenced' }));
    expect(router.status().online).toBe(false);
    expect(router.takeWorkerConnectionsToFence()).toEqual(['connection-1']);
  });

  it('disconnects a revoked registered client before forwarding more data', () => {
    const { metadata, router } = onlineFixture();
    router.routeFromClient(
      'client-a',
      frame('client-to-worker', 'client-revoked', 0, 'open'),
    );
    router.drainWorker();
    revoke(metadata, 'client-credential-a');

    expect(
      router.routeFromClient(
        'client-a',
        frame('client-to-worker', 'client-revoked', 1, 'data'),
      ),
    ).toEqual({ accepted: false, error: 'resync_required' });
    expect(router.takeClientDisconnects()).toEqual([
      { clientId: 'client-a', reason: 'resync_required' },
    ]);
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ kind: 'reset', resetCode: 'cancelled' }),
    ]);
  });

  it('drops already queued client business frames when the client credential is revoked', () => {
    const { metadata, router } = onlineFixture();
    router.routeFromClient(
      'client-a',
      frame('client-to-worker', 'client-revoked-queued', 0, 'open'),
    );
    router.routeFromClient(
      'client-a',
      frame('client-to-worker', 'client-revoked-queued', 1, 'data'),
    );
    revoke(metadata, 'client-credential-a');

    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({ kind: 'reset', resetCode: 'cancelled' }),
    ]);
    expect(router.takeClientDisconnects()).toEqual([
      { clientId: 'client-a', reason: 'resync_required' },
    ]);
  });

  it('binds a Feishu credential to the Feishu surface on the Worker open frame', () => {
    const { metadata, router } = onlineFixture();
    metadata.put('credentials', credential('feishu-credential-a', 'feishu'));
    expect(() =>
      router.registerClient(
        'wrong-surface',
        'feishu-credential-a',
        'desktop-full',
      ),
    ).toThrowError(expect.objectContaining<Partial<RelayRouterError>>({
      code: 'credential_invalid',
    }));

    router.registerClient(
      'feishu-client-a',
      'feishu-credential-a',
      'feishu-session-console',
    );
    expect(router.routeFromClient(
      'feishu-client-a',
      frame('client-to-worker', 'feishu-route', 0, 'open'),
    )).toEqual({ accepted: true, error: null });
    expect(router.drainWorker()?.frames).toEqual([
      expect.objectContaining({
        kind: 'open',
        accessCredentialId: 'feishu-credential-a',
        accessSurface: 'feishu-session-console',
      }),
    ]);
  });

  it('revalidates the credential kind against the registered surface on every route', () => {
    const { metadata, router } = onlineFixture();
    metadata.put('credentials', credential('feishu-credential-a', 'feishu'));
    router.registerClient(
      'feishu-client-a',
      'feishu-credential-a',
      'feishu-session-console',
    );
    metadata.put('credentials', credential('feishu-credential-a', 'ssh-client'));

    expect(router.routeFromClient(
      'feishu-client-a',
      frame('client-to-worker', 'surface-changed', 0, 'open'),
    )).toEqual({ accepted: false, error: 'resync_required' });
    expect(router.takeClientDisconnects()).toEqual([
      { clientId: 'feishu-client-a', reason: 'resync_required' },
    ]);
  });
});
