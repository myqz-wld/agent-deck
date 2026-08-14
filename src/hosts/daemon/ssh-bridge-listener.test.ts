import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

import { encodeBridgeAdmission, encodeJsonFrame } from '@protocol/index';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';
import { describe, expect, it, vi } from 'vitest';

import {
  createHost,
  createRuntime,
  findMessage,
  hello,
  TestDuplex,
  waitFor,
} from './connection-test-helpers';
import { DaemonSshBridgeListener } from './ssh-bridge-listener';
import type { DaemonListener } from './types';

class FakeListener implements DaemonListener {
  private onConnection: ((stream: Duplex) => void) | null = null;

  async start(onConnection: (stream: Duplex) => void): Promise<void> {
    this.onConnection = onConnection;
  }

  async stop(): Promise<void> {
    this.onConnection = null;
  }

  connect(stream: Duplex): void {
    if (!this.onConnection) throw new Error('listener is not running');
    this.onConnection(stream);
  }
}

function coalescedClientBytes(
  credentialId = 'ssh-credential-a',
  surface: 'desktop' | 'feishu' = 'desktop',
  clientId = 'desktop-bridge',
): Uint8Array {
  const admission = encodeBridgeAdmission({
    version: 2,
    topology: 'full',
    role: 'client',
    instanceId: 'tenant-a',
    credentialId,
    connectionScope: deriveConnectionScope('tenant-a', credentialId),
    surface,
  });
  const clientHello = encodeJsonFrame(hello(clientId));
  return Buffer.concat([Buffer.from(admission), Buffer.from(clientHello)]);
}

describe('daemon SSH forced-command admission', () => {
  it('preserves a coalesced Core hello and creates identity out of band', async () => {
    const authorize = vi.fn(() => true);
    const host = createHost(createRuntime());
    const listener = new FakeListener();
    const bridge = new DaemonSshBridgeListener({
      instanceId: 'tenant-a',
      host,
      listener,
      authorize,
    });
    await host.start();
    await bridge.start();
    const stream = new TestDuplex();
    listener.connect(stream);
    stream.feedBytes(coalescedClientBytes());

    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'bridge hello');
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: 'ssh-credential-a' }),
    );
    expect(findMessage(stream, 'hello-result')).toMatchObject({
      hello: {
        instanceId: 'tenant-a',
        access: {
          clientId: 'desktop-bridge',
          connectionScope: deriveConnectionScope('tenant-a', 'ssh-credential-a'),
          authority: 'owner-equivalent',
        },
      },
    });
    await bridge.stop();
    await host.stop();
  });

  it('returns revoked before dispatch and rejects mismatched instance headers', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const host = createHost(createRuntime({ execute }));
    const listener = new FakeListener();
    const bridge = new DaemonSshBridgeListener({
      instanceId: 'tenant-a',
      host,
      listener,
      authorize: () => false,
    });
    await host.start();
    await bridge.start();

    const revoked = new TestDuplex();
    listener.connect(revoked);
    revoked.feedBytes(coalescedClientBytes('revoked-credential'));
    await waitFor(() => Boolean(findMessage(revoked, 'error')), 'revoked error');
    expect(findMessage(revoked, 'error')).toMatchObject({ error: { code: 'revoked' } });

    const mismatch = new TestDuplex();
    listener.connect(mismatch);
    mismatch.feedBytes(
      encodeBridgeAdmission({
        version: 2,
        topology: 'full',
        role: 'client',
        instanceId: 'tenant-b',
        credentialId: 'ssh-credential-b',
        connectionScope: deriveConnectionScope('tenant-b', 'ssh-credential-b'),
        surface: 'desktop',
      }),
    );
    await waitFor(() => mismatch.destroyed, 'mismatched admission close');
    expect(execute).not.toHaveBeenCalled();
    await bridge.stop();
    await host.stop();
  });

  it('creates an exact Feishu access context from the trusted admission header', async () => {
    const authorize = vi.fn(() => true);
    const host = createHost(createRuntime());
    const listener = new FakeListener();
    const bridge = new DaemonSshBridgeListener({
      instanceId: 'tenant-a',
      host,
      listener,
      authorize,
    });
    await host.start();
    await bridge.start();
    const stream = new TestDuplex();
    listener.connect(stream);
    stream.feedBytes(coalescedClientBytes(
      'feishu-credential-a',
      'feishu',
      'feishu-client-a',
    ));

    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'Feishu bridge hello');
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'feishu-credential-a',
      surface: 'feishu',
    }));
    expect(findMessage(stream, 'hello-result')).toMatchObject({
      hello: {
        access: {
          clientId: 'feishu-client-a',
          connectionScope: deriveConnectionScope('tenant-a', 'feishu-credential-a'),
          transport: 'feishu',
          surface: 'feishu',
        },
      },
    });
    await bridge.stop();
    await host.stop();
  });
});
