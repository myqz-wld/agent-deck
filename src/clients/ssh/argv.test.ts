import { describe, expect, it } from 'vitest';

import { AGENT_DECK_SSH_BRIDGE_COMMAND, buildOpenSshArgv } from './argv';
import { SshAgentDeckClient } from './client';
import type { SshHostProfile } from './types';
import { FakeSpawnHarness, makeClientHello } from './__tests__/fake-process';

export function makeSshProfile(
  overrides: Partial<SshHostProfile> = {},
): SshHostProfile {
  return {
    id: 'server-profile',
    label: 'Server A',
    topology: 'server-core',
    hostname: 'core.example.test',
    port: 2222,
    username: 'agentdeck',
    identityFile: '/tmp/agent-deck-client-key',
    knownHostsFile: '/tmp/agent-deck-known-hosts',
    expectedInstanceId: 'server-a',
    ...overrides,
  };
}

describe('OpenSSH argv boundary', () => {
  it('spawns a strict argv-only forced-command session without forwarding or PTY', async () => {
    const harness = new FakeSpawnHarness();
    const profile = makeSshProfile({ sshBinary: '/usr/bin/ssh' });
    const client = new SshAgentDeckClient(profile, {
      spawn: harness.spawn,
      reconnect: { maxAttempts: 0 },
      timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    });

    void client.connect(makeClientHello('desktop-a')).catch(() => undefined);
    const call = harness.calls[0];
    expect(call.binary).toBe('/usr/bin/ssh');
    expect(call.options).toMatchObject({
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(call.argv).toEqual(buildOpenSshArgv(profile));
    expect(call.argv).toEqual(
      expect.arrayContaining([
        '-T',
        'BatchMode=yes',
        'StrictHostKeyChecking=yes',
        'UserKnownHostsFile="/tmp/agent-deck-known-hosts"',
        'UpdateHostKeys=no',
        'IdentitiesOnly=yes',
        'IdentityFile=none',
        'IdentityAgent=none',
        'ClearAllForwardings=yes',
        'ProxyCommand=none',
        'ProxyJump=none',
        'ForwardAgent=no',
        'ForwardX11=no',
        'RequestTTY=no',
        'PermitLocalCommand=no',
        'LocalCommand=none',
        'RemoteCommand=none',
        'Tunnel=no',
        'AddKeysToAgent=no',
        'ServerAliveInterval=15',
        'ServerAliveCountMax=3',
      ]),
    );
    expect(call.argv.slice(-3)).toEqual([
      '--',
      'agentdeck@core.example.test',
      AGENT_DECK_SSH_BRIDGE_COMMAND,
    ]);
    expect(call.argv).not.toContain('-N');
    expect(call.argv).not.toContain('-t');
    expect(call.argv).not.toContain('-L');
    expect(call.argv).not.toContain('-R');
    expect(call.argv).not.toContain('-D');
    await client.close();
  });

  it('rejects option-shaped hosts and non-absolute trust/key files', () => {
    expect(() => buildOpenSshArgv(makeSshProfile({ hostname: '-ProxyCommand=bad' }))).toThrowError(
      'profile.hostname',
    );
    expect(() => buildOpenSshArgv(makeSshProfile({ knownHostsFile: 'known_hosts' }))).toThrowError(
      'explicit absolute paths',
    );
    expect(
      buildOpenSshArgv(makeSshProfile({ knownHostsFile: '/tmp/Agent Deck/known hosts' })),
    ).toContain('UserKnownHostsFile="/tmp/Agent Deck/known hosts"');
  });
});
