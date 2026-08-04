import { Buffer } from 'node:buffer';

import {
  encodeBridgeAdmission,
  encodeWorkerWireMessage,
  WorkerWireDecoder,
  type RelayRouteFrame,
} from '@protocol/index';
import { describe, expect, it } from 'vitest';

import { TestDuplex, waitFor } from '../daemon/connection-test-helpers';
import { RelayControlHost } from './control-host';
import { RelayMetadataStore } from './metadata';
import { RelayStreamRouter } from './router';

function router(): RelayStreamRouter {
  const metadata = new RelayMetadataStore();
  metadata.put('instances', {
    id: 'instance-a',
    instanceId: 'instance-a',
    topology: 'relay',
    createdAt: 0,
  });
  for (const [credentialId, kind] of [
    ['worker-credential', 'relay-worker'],
    ['client-credential', 'ssh-client'],
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
  return new RelayStreamRouter('instance-a', metadata);
}

function workerAdmission(): Uint8Array {
  return encodeBridgeAdmission({
    version: 1,
    topology: 'relay',
    role: 'worker',
    instanceId: 'instance-a',
    credentialId: 'worker-credential',
    workerId: 'worker-a',
  });
}

function clientAdmission(): Uint8Array {
  return encodeBridgeAdmission({
    version: 1,
    topology: 'relay',
    role: 'client',
    instanceId: 'instance-a',
    credentialId: 'client-credential',
  });
}

describe('private Relay control host', () => {
  it('round-trips opaque Core bytes without persisting or interpreting them', async () => {
    const relayRouter = router();
    const host = new RelayControlHost({ router: relayRouter });
    host.start();
    const worker = new TestDuplex(1024 * 1024);
    host.accept(worker);
    const attach = encodeWorkerWireMessage({
      type: 'attach',
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'worker-credential',
      mode: 'register',
      generation: null,
      expectedGeneration: null,
    });
    worker.feedBytes(Buffer.concat([Buffer.from(workerAdmission()), Buffer.from(attach)]));
    await waitFor(() => worker.writes.length > 0, 'Worker attached response');
    expect(new WorkerWireDecoder().push(Buffer.concat(worker.writes))[0]).toMatchObject({
      type: 'attached',
      generation: 1,
    });

    const client = new TestDuplex(1024 * 1024);
    host.accept(client);
    const requestBytes = Buffer.from('opaque-core-request');
    client.feedBytes(Buffer.concat([Buffer.from(clientAdmission()), requestBytes]));
    await waitFor(
      () =>
        new WorkerWireDecoder()
          .push(Buffer.concat(worker.writes))
          .filter((message) => message.type === 'route').length >= 2,
      'opaque request routes',
    );
    const routes = new WorkerWireDecoder()
      .push(Buffer.concat(worker.writes))
      .filter((message) => message.type === 'route');
    const open = routes.find((message) => message.type === 'route' && message.frame.kind === 'open');
    const data = routes.find((message) => message.type === 'route' && message.frame.kind === 'data');
    expect(data).toMatchObject({ type: 'route', frame: { payload: requestBytes } });
    if (!open || open.type !== 'route') throw new Error('missing open route');

    const response: RelayRouteFrame = {
      instanceId: 'instance-a',
      generation: 1,
      streamId: open.frame.streamId,
      direction: 'worker-to-client',
      sequence: 0,
      kind: 'data',
      payload: Buffer.from('opaque-core-response'),
      creditBytes: null,
      resetCode: null,
    };
    worker.feedBytes(encodeWorkerWireMessage({ type: 'route', frame: response }));
    await waitFor(() => client.writes.length > 0, 'opaque response');
    expect(Buffer.concat(client.writes).toString()).toBe('opaque-core-response');
    expect(relayRouter.metadata.exportSnapshot()).not.toContain('opaque-core-request');
    expect(relayRouter.metadata.exportSnapshot()).not.toContain('opaque-core-response');
    host.stop();
  });

  it('closes an admitted client while no authoritative Worker is online', async () => {
    const host = new RelayControlHost({ router: router() });
    host.start();
    const client = new TestDuplex(1024 * 1024);
    host.accept(client);
    client.feedBytes(clientAdmission());
    await waitFor(() => client.destroyed, 'offline client close');
    expect(host.clientCount).toBe(0);
    host.stop();
  });
});
