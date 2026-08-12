import { describe, expect, it, vi } from 'vitest';

import { SshConnectionStatePublisher } from './connection-state';
import type { SshHostProfile } from './types';

const PROFILE: Readonly<SshHostProfile> = Object.freeze({
  id: 'remote-a',
  label: 'Remote A',
  topology: 'server-core',
  hostname: 'remote.example.test',
  port: 22,
  username: 'agentdeck',
  identityFile: '/private/key',
  knownHostsFile: '/private/known-hosts',
});

describe('SshConnectionStatePublisher', () => {
  it('does not notify observers for an exactly equivalent state', () => {
    const publisher = new SshConnectionStatePublisher(PROFILE);
    const listener = vi.fn();
    publisher.subscribe(listener);
    publisher.publish('reconnecting', 1, null, 'transport closed', 'connection_failed');
    publisher.publish('reconnecting', 1, null, 'transport closed', 'connection_failed');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
