import { describe, expect, it } from 'vitest';

import { resolveRelayForcedCommandBinding } from './forced-command-binding';

const flags = {
  '--instance': 'instance-a',
  '--credential': 'credential-a',
  '--worker': 'worker-a',
  '--surface': 'desktop-full',
  '--socket': '/run/user/1001/agent-deck-relay/instance-a/control.sock',
};

describe('Relay forced-command binding', () => {
  it('binds Worker identity and the exact host-visible per-instance socket', () => {
    expect(resolveRelayForcedCommandBinding('worker', flags, 1001)).toEqual({
      admission: {
        version: 1,
        topology: 'relay',
        role: 'worker',
        instanceId: 'instance-a',
        credentialId: 'credential-a',
        workerId: 'worker-a',
      },
      socketPath: flags['--socket'],
      expectedOriginalCommand:
        'agent-deck-relay attach --instance instance-a --credential credential-a --worker worker-a',
    });
  });

  it('rejects a foreign uid or instance socket', () => {
    expect(() => resolveRelayForcedCommandBinding('worker', flags, 1002)).toThrow(
      'exact service instance namespace',
    );
    expect(() => resolveRelayForcedCommandBinding('client', {
      ...flags,
      '--socket': '/run/user/1001/agent-deck-relay/other/control.sock',
    }, 1001)).toThrow('exact service instance namespace');
  });

  it('binds the provisioned Feishu surface independently from a desktop key', () => {
    expect(resolveRelayForcedCommandBinding('client', {
      ...flags,
      '--surface': 'feishu-session-console',
    }, 1001).admission).toEqual({
      version: 1,
      topology: 'relay',
      role: 'client',
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      surface: 'feishu-session-console',
    });
  });

  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact Relay instance %s before socket routing',
    (instanceId) => {
      expect(() => resolveRelayForcedCommandBinding('worker', {
        ...flags,
        '--instance': instanceId,
      }, 1001)).toThrow('lowercase Linux instance label');
    },
  );
});
