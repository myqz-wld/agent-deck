import { Duplex, PassThrough } from 'node:stream';

import { BridgeAdmissionDecoder } from '@protocol/index';
import { describe, expect, it, vi } from 'vitest';

import {
  runSshClientBridgeTunnel,
  SSH_BRIDGE_ORIGINAL_COMMAND,
} from './tunnel';

describe('restricted SSH client bridge tunnel', () => {
  it('writes trusted admission before forwarding opaque stdio in both directions', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const socket = Duplex.from({ writable: clientToServer, readable: serverToClient });
    const upstream: Buffer[] = [];
    const downstream: Buffer[] = [];
    clientToServer.on('data', (chunk) => upstream.push(Buffer.from(chunk)));
    output.on('data', (chunk) => downstream.push(Buffer.from(chunk)));

    const running = runSshClientBridgeTunnel({
      admission: {
        version: 1,
        topology: 'server-core',
        role: 'client',
        instanceId: 'tenant-a',
        credentialId: 'ssh-credential-a',
      },
      socketPath: '/run/agent-deck/tenant-a/agent-deckd.sock',
      originalCommand: SSH_BRIDGE_ORIGINAL_COMMAND,
      input,
      output,
      connect: async () => socket,
    });
    input.end(Buffer.from('opaque-client-bytes'));
    serverToClient.end(Buffer.from('opaque-server-bytes'));
    await running;

    const decoded = new BridgeAdmissionDecoder().push(Buffer.concat(upstream));
    expect(decoded?.admission).toMatchObject({
      topology: 'server-core',
      instanceId: 'tenant-a',
      credentialId: 'ssh-credential-a',
    });
    expect(Buffer.from(decoded?.remainder ?? []).toString()).toBe('opaque-client-bytes');
    expect(Buffer.concat(downstream).toString()).toBe('opaque-server-bytes');
  });

  it('rejects a non-fixed original command before touching the private socket', async () => {
    const connect = vi.fn(async () => new PassThrough());
    await expect(
      runSshClientBridgeTunnel({
        admission: {
          version: 1,
          topology: 'relay',
          role: 'client',
          instanceId: 'tenant-a',
          credentialId: 'ssh-credential-a',
        },
        socketPath: '/run/agent-deck-relay/tenant-a/control.sock',
        originalCommand: 'sh',
        input: new PassThrough(),
        output: new PassThrough(),
        connect,
      }),
    ).rejects.toThrow('does not match');
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects ambiguous socket paths', async () => {
    await expect(
      runSshClientBridgeTunnel({
        admission: {
          version: 1,
          topology: 'server-core',
          role: 'client',
          instanceId: 'tenant-a',
          credentialId: 'ssh-credential-a',
        },
        socketPath: '/run/agent-deck/../other.sock',
        originalCommand: SSH_BRIDGE_ORIGINAL_COMMAND,
        input: new PassThrough(),
        output: new PassThrough(),
      }),
    ).rejects.toThrow('normalized');
  });
});
