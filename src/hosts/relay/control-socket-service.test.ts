import type { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { RelayControlHost } from './control-host';
import {
  RelayControlSocketService,
  type RelayControlListener,
} from './control-socket-service';

describe('Relay private control socket lifecycle', () => {
  it('starts the router host before ingress and stops ingress before the host', async () => {
    const calls: string[] = [];
    const host = {
      start: vi.fn(() => calls.push('host:start')),
      stop: vi.fn(() => calls.push('host:stop')),
      accept: vi.fn(),
    } as unknown as RelayControlHost;
    const listener: RelayControlListener = {
      async start(_onConnection: (stream: Duplex) => void) {
        calls.push('listener:start');
      },
      async stop() {
        calls.push('listener:stop');
      },
    };
    const service = new RelayControlSocketService(host, listener);
    await service.start();
    await service.stop();
    expect(calls).toEqual(['host:start', 'listener:start', 'listener:stop', 'host:stop']);
  });

  it('rolls back the host when the private listener cannot start', async () => {
    const host = {
      start: vi.fn(),
      stop: vi.fn(),
      accept: vi.fn(),
    } as unknown as RelayControlHost;
    const service = new RelayControlSocketService(host, {
      start: async () => {
        throw new Error('listener failed');
      },
      stop: vi.fn(),
    });
    await expect(service.start()).rejects.toThrow('listener failed');
    expect(host.stop).toHaveBeenCalledOnce();
  });
});
