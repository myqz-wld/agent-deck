import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRelayForcedCommand } from './entrypoint-command';
import { resolveRelayForcedCommandBinding } from './forced-command-binding';

interface FixtureCommand {
  readonly role: 'client' | 'worker';
  readonly command: string;
  readonly expectedAdmission: Readonly<Record<string, unknown>>;
}

function fixtureCommands(): FixtureCommand[] {
  const relay = resolve(process.cwd(), 'deploy/linux/relay');
  const worker = readFileSync(resolve(relay, 'authorized-key-options.txt'), 'utf8');
  const clients = readFileSync(resolve(relay, 'authorized-client-key-options.txt'), 'utf8');
  const extract = (source: string): string[] => [...source.matchAll(/command="([^"]+)"/g)]
    .map((match) => match[1])
    .map((command) => command
      .replaceAll('INSTANCE_ID', 'instance-a')
      .replaceAll('CREDENTIAL_ID', 'credential-a')
      .replaceAll('WORKER_ID', 'worker-a')
      .replaceAll('RUNTIME_UID', '1001'));
  const [workerCommand] = extract(worker);
  const [desktopCommand, feishuCommand] = extract(clients);
  if (!workerCommand || !desktopCommand || !feishuCommand) {
    throw new Error('Relay authorized-key fixtures are incomplete');
  }
  return [
    {
      role: 'worker',
      command: workerCommand,
      expectedAdmission: {
        version: 1,
        topology: 'relay',
        role: 'worker',
        instanceId: 'instance-a',
        credentialId: 'credential-a',
        workerId: 'worker-a',
      },
    },
    {
      role: 'client',
      command: desktopCommand,
      expectedAdmission: {
        version: 1,
        topology: 'relay',
        role: 'client',
        instanceId: 'instance-a',
        credentialId: 'credential-a',
        surface: 'desktop-full',
      },
    },
    {
      role: 'client',
      command: feishuCommand,
      expectedAdmission: {
        version: 1,
        topology: 'relay',
        role: 'client',
        instanceId: 'instance-a',
        credentialId: 'credential-a',
        surface: 'feishu-session-console',
      },
    },
  ];
}

describe('packaged Relay forced-command contract', () => {
  it.each(fixtureCommands())(
    'parses and binds $role fixture through the production command schema',
    ({ role, command, expectedAdmission }) => {
      const [, ...argv] = command.split(' ');
      const parsed = parseRelayForcedCommand(argv);
      expect(parsed?.role).toBe(role);
      expect(resolveRelayForcedCommandBinding(
        role,
        parsed?.flags ?? {},
        1001,
      ).admission).toEqual(expectedAdmission);
    },
  );

  it('rejects the inverse surface schemas that caused the packaged outage', () => {
    expect(() => parseRelayForcedCommand([
      'attach', '--instance', 'instance-a', '--credential', 'credential-a',
      '--surface', 'desktop-full', '--socket',
      '/run/user/1001/agent-deck-relay/instance-a/control.sock',
      '--worker', 'worker-a',
    ])).toThrow('unknown or duplicate flag');
    expect(() => parseRelayForcedCommand([
      'bridge', '--instance', 'instance-a', '--credential', 'credential-a',
      '--socket', '/run/user/1001/agent-deck-relay/instance-a/control.sock',
    ])).toThrow('command requires --surface');
  });
});
