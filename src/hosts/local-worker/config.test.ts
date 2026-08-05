import { describe, expect, it } from 'vitest';

import {
  buildLocalWorkerSshArgv,
  createWorkerEnrollmentRequest,
  type LocalWorkerSshConfig,
} from './config';

const CONFIG: LocalWorkerSshConfig = {
  sshBinary: '/usr/bin/ssh',
  host: 'relay.example.com',
  port: 22,
  user: 'agent-deck-relay',
  identityFile: '/var/lib/agent-deck-worker/id_ed25519',
  knownHostsFile: '/var/lib/agent-deck-worker/known_hosts',
  instanceId: 'instance-a',
  workerId: 'worker-a',
  credentialId: 'credential-a',
  connectTimeoutSeconds: 10,
};

describe('local Worker outbound SSH boundary', () => {
  it('pins the host key and disables every inbound/tunnel/interactive surface', () => {
    const argv = buildLocalWorkerSshArgv(CONFIG);
    expect(argv.slice(0, 2)).toEqual(['-F', '/dev/null']);
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain(`UserKnownHostsFile="${CONFIG.knownHostsFile}"`);
    expect(argv).toContain('GlobalKnownHostsFile=/dev/null');
    expect(argv).toContain('IdentityAgent=none');
    expect(argv).toContain('IdentityFile=none');
    expect(argv.indexOf('IdentityFile=none')).toBeLessThan(argv.indexOf('-i'));
    for (const option of [
      'UpdateHostKeys=no',
      'PreferredAuthentications=publickey',
      'PubkeyAuthentication=yes',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'HostbasedAuthentication=no',
      'GSSAPIAuthentication=no',
      'ProxyCommand=none',
      'ProxyJump=none',
      'ControlMaster=no',
      'ControlPersist=no',
      'ControlPath=none',
      'ForwardX11Trusted=no',
      'Tunnel=no',
      'RemoteCommand=none',
      'LocalCommand=none',
      'AddKeysToAgent=no',
      'EscapeChar=none',
      'TCPKeepAlive=no',
    ]) {
      expect(argv).toContain(option);
    }
    expect(argv).toContain('ClearAllForwardings=yes');
    expect(argv).toContain('ForwardAgent=no');
    expect(argv).toContain('ForwardX11=no');
    expect(argv).toContain('RequestTTY=no');
    expect(argv).toContain('-T');
    expect(argv.at(argv.indexOf(`${CONFIG.user}@${CONFIG.host}`) - 1)).toBe('--');
    for (const forwardingFlag of ['-L', '-R', '-D', '-W']) {
      expect(argv).not.toContain(forwardingFlag);
    }
    expect(argv).toEqual(
      expect.arrayContaining(['agent-deck-relay', 'attach', '--instance', 'instance-a']),
    );
    expect(argv.slice(-7)).toEqual([
      'attach',
      '--instance',
      CONFIG.instanceId,
      '--credential',
      CONFIG.credentialId,
      '--worker',
      CONFIG.workerId,
    ]);
  });

  it('provisions only public key material across the Relay boundary', () => {
    expect(
      createWorkerEnrollmentRequest({
        instanceId: 'instance-a',
        workerId: 'worker-a',
        credentialId: 'credential-a',
        publicKey: 'ssh-ed25519 AAAATEST worker-a',
        fingerprint: 'SHA256:test',
      }),
    ).toEqual(expect.objectContaining({ publicKey: 'ssh-ed25519 AAAATEST worker-a' }));
    expect(() =>
      createWorkerEnrollmentRequest({
        instanceId: 'instance-a',
        workerId: 'worker-a',
        credentialId: 'credential-a',
        publicKey: 'ssh-ed25519 -----BEGIN OPENSSH PRIVATE KEY-----',
        fingerprint: 'SHA256:test',
      }),
    ).toThrow('public material only');
    expect(() =>
      createWorkerEnrollmentRequest({
        instanceId: '--other',
        workerId: 'worker-a',
        credentialId: 'credential-a',
        publicKey: 'ssh-ed25519 AAAATEST worker-a',
        fingerprint: 'SHA256:test',
      }),
    ).toThrow('instanceId');
  });

  it('rejects relative key paths instead of weakening host verification', () => {
    expect(() => buildLocalWorkerSshArgv({ ...CONFIG, knownHostsFile: 'known_hosts' })).toThrow(
      'knownHostsFile must be an absolute local path',
    );
  });

  it('quotes known-host paths with spaces and rejects OpenSSH path expansion', () => {
    const argv = buildLocalWorkerSshArgv({
      ...CONFIG,
      knownHostsFile: '/var/lib/agent deck/known_hosts',
    });
    expect(argv).toContain('UserKnownHostsFile="/var/lib/agent deck/known_hosts"');
    expect(() =>
      buildLocalWorkerSshArgv({ ...CONFIG, identityFile: '/worker/%h/id_ed25519' }),
    ).toThrow('OpenSSH expansion tokens');
    expect(() =>
      buildLocalWorkerSshArgv({ ...CONFIG, knownHostsFile: '/worker/${HOME}/known_hosts' }),
    ).toThrow('OpenSSH expansion tokens');
  });

  it.each([
    ['host', '-oProxyCommand=bad'],
    ['host', 'relay.example.com;bad'],
    ['user', '-root'],
    ['user', 'user@relay'],
    ['instanceId', '--help'],
    ['workerId', 'worker/other'],
    ['credentialId', 'credential value'],
  ] as const)('rejects ambiguous %s token %s', (field, value) => {
    expect(() => buildLocalWorkerSshArgv({ ...CONFIG, [field]: value })).toThrow(field);
  });

  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact Linux instance %s before forming SSH argv',
    (instanceId) => {
      expect(() => buildLocalWorkerSshArgv({ ...CONFIG, instanceId })).toThrow('instanceId');
    },
  );
});
