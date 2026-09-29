import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

import { encodeBridgeAdmission, encodeWorkerWireMessage, WorkerWireDecoder, type RelayRouteFrame } from '@protocol/index';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';
import { TestDuplex, waitFor } from '../daemon/connection-test-helpers';
import { RelayControlHost } from './control-host';
import { RelayMetadataStore } from './metadata';
import { RelayStreamRouter } from './router';

async function connectedPair() {
  const metadata = new RelayMetadataStore();
  metadata.put('instances', { id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 0 });
  for (const [credentialId, kind] of [['worker-credential', 'relay-worker'], ['client-credential', 'ssh-client']] as const) {
    metadata.put('credentials', {
      id: credentialId, instanceId: 'instance-a', credentialId, kind,
      publicKey: 'ssh-ed25519 AAAATEST', fingerprint: `SHA256:${credentialId}`,
      status: 'active', createdAt: 1, revokedAt: null,
    });
  }
  const router = new RelayStreamRouter('instance-a', metadata);
  const host = new RelayControlHost({ router });
  host.start();
  const worker = new TestDuplex(1024 * 1024);
  host.accept(worker);
  worker.feedBytes(Buffer.concat([
    encodeBridgeAdmission({ version: 2, topology: 'relay', role: 'worker', instanceId: 'instance-a', credentialId: 'worker-credential', workerId: 'worker-a' }),
    encodeWorkerWireMessage({ type: 'attach', instanceId: 'instance-a', workerId: 'worker-a', credentialId: 'worker-credential', mode: 'register', generation: null, expectedGeneration: null }),
  ]));
  await waitFor(() => worker.writes.length > 0, 'worker attachment');
  const clients = [new TestDuplex(1024 * 1024), new TestDuplex(1024 * 1024)];
  for (const client of clients) {
    host.accept(client);
    client.feedBytes(encodeBridgeAdmission({
      version: 2, topology: 'relay', role: 'client', instanceId: 'instance-a',
      credentialId: 'client-credential', surface: 'desktop',
      connectionScope: deriveConnectionScope('instance-a', 'client-credential'),
    }));
  }
  await waitFor(() => metadata.rows('routes').length === 2, 'client streams');
  const routes = new WorkerWireDecoder().push(Buffer.concat(worker.writes))
    .filter((message) => message.type === 'route' && message.frame.kind === 'open')
    .map((message) => (message as { frame: RelayRouteFrame }).frame);
  return { host, router, worker, clients, routes };
}

describe('Relay stream retirement isolation', () => {
  it.each([
    { generation: 2 },
    { instanceId: 'other-instance' },
    { direction: 'client-to-worker' },
  ] as const)('still rejects invalid attachment identity after retirement: %j', async (patch) => {
    const { host, router, clients, routes } = await connectedPair();
    try {
      clients[0].destroy();
      await waitFor(() => host.clientCount === 1, 'client retirement');
      const incoming: RelayRouteFrame = {
        ...routes[0], direction: 'worker-to-client', sequence: 0, kind: 'credit',
        payload: new Uint8Array(), creditBytes: 1, resetCode: null,
        connectionScope: null, accessSurface: null, accessGrant: null, ...patch,
      };
      expect(() => router.routeFromWorker(router.status().connectionId!, incoming)).toThrow();
    } finally { host.stop(); }
  });

  it.each(['credit', 'data', 'close', 'reset'] as const)('keeps other clients online when a retired stream receives late %s', async (kind) => {
    const { host, router, worker, clients, routes } = await connectedPair();
    try {
      clients[0].destroy();
      await waitFor(() => host.clientCount === 1, 'first client retirement');
      const route = vi.spyOn(router, 'routeFromWorker');
      worker.feedBytes(encodeWorkerWireMessage({ type: 'route', frame: {
        ...routes[0], direction: 'worker-to-client', sequence: 0, kind,
        payload: kind === 'data' ? Buffer.from('late') : new Uint8Array(),
        creditBytes: kind === 'credit' ? 1 : null,
        resetCode: kind === 'reset' ? 'cancelled' : null,
        connectionScope: null, accessSurface: null, accessGrant: null,
      } }));
      await waitFor(() => route.mock.calls.length > 0, 'late frame delivery');
      expect(host.workerCount).toBe(1);
      expect(router.status().online).toBe(true);
      expect(clients[1].destroyed).toBe(false);
      worker.feedBytes(encodeWorkerWireMessage({ type: 'route', frame: {
        ...routes[1], direction: 'worker-to-client', sequence: 0, kind: 'data',
        payload: Buffer.from('still-online'), creditBytes: null, resetCode: null,
        connectionScope: null, accessSurface: null, accessGrant: null,
      } }));
      await waitFor(() => clients[1].writes.length > 0, 'other client response');
      expect(Buffer.concat(clients[1].writes).toString()).toBe('still-online');
    } finally {
      host.stop();
    }
  });
});
