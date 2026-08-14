import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { encodeBridgeAdmission } from '@protocol/index';

import { runForcedCommandTunnel } from './forced-command';

describe('forced-command tunnel', () => {
  it('uses only provisioned identity and writes the exact admission before opaque bytes', async () => {
    const socket = new PassThrough();
    const output: Buffer[] = [];
    const connect = vi.fn(async () => socket);
    const admission = {
      version: 2 as const,
      topology: 'relay' as const,
      role: 'worker' as const,
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      workerId: 'worker-a',
    };
    await runForcedCommandTunnel({
      admission,
      socketPath: '/run/user/1000/relay.sock',
      expectedOriginalCommand: 'agent-deck-relay attach --instance instance-a --credential credential-a --worker worker-a',
      originalCommand: 'agent-deck-relay attach --instance instance-a --credential credential-a --worker worker-a',
      input: Readable.from([Buffer.from('opaque')]),
      output: new Writable({ write: (chunk, _encoding, done) => { output.push(Buffer.from(chunk)); done(); } }),
      connect,
    });
    expect(connect).toHaveBeenCalledWith('/run/user/1000/relay.sock');
    expect(Buffer.concat(output)).toEqual(Buffer.concat([
      Buffer.from(encodeBridgeAdmission(admission)),
      Buffer.from('opaque'),
    ]));
  });

  it('rejects an original-command mismatch before opening a socket', async () => {
    const connect = vi.fn();
    await expect(runForcedCommandTunnel({
      admission: {
        version: 2,
        topology: 'full',
        role: 'client',
        instanceId: 'instance-a',
        credentialId: 'credential-a',
        connectionScope: 'scope-credential-a',
        surface: 'desktop',
      },
      socketPath: '/run/agent-deck.sock',
      expectedOriginalCommand: 'agent-deck-bridge',
      originalCommand: 'agent-deck-bridge --instance other',
      input: Readable.from([]),
      output: new PassThrough(),
      connect,
    })).rejects.toThrow('does not match');
    expect(connect).not.toHaveBeenCalled();
  });
});
