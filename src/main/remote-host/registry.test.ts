import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getRemoteHostService,
  setRemoteHostService,
  shutdownRemoteHostServiceIfCreated,
} from './registry';
import type { RemoteHostService } from './service';

afterEach(() => {
  setRemoteHostService(null);
});

describe('remote host service registry shutdown', () => {
  it('does not eagerly create a service and rejects late startup after shutdown', async () => {
    setRemoteHostService(null);

    await shutdownRemoteHostServiceIfCreated();

    expect(() => getRemoteHostService()).toThrowError(
      expect.objectContaining({ code: 'service_stopped' }),
    );
  });

  it('retires an existing service once and remains terminal', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const service = { shutdown } as unknown as RemoteHostService;
    setRemoteHostService(service);

    const first = shutdownRemoteHostServiceIfCreated();
    const second = shutdownRemoteHostServiceIfCreated();

    expect(second).toBe(first);
    await first;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(() => getRemoteHostService()).toThrowError(
      expect.objectContaining({ code: 'service_stopped' }),
    );
  });
});
