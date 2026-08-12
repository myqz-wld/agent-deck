import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AdapterContext } from '../types';
import {
  AdapterRegistryClass,
  type AdapterRegistryDiagnosticPort,
} from '../registry-core';

function adapter(id: string, init: () => void | Promise<void>): AgentAdapter {
  return {
    id,
    displayName: id,
    capabilities: {} as AgentAdapter['capabilities'],
    init: vi.fn(init),
    shutdown: vi.fn(async () => undefined),
  } as AgentAdapter;
}

describe('adapter registry core diagnostics port', () => {
  it('preserves raw lifecycle results while reporting only aggregate counts', async () => {
    const failure = { message: 'private provider failure' };
    const diagnostics: AdapterRegistryDiagnosticPort = {
      begin: vi.fn(() => 41),
      observe: vi.fn(),
    };
    const registry = new AdapterRegistryClass(diagnostics);
    registry.register(adapter('failed', () => { throw failure; }));
    registry.register(adapter('healthy', async () => undefined));

    const results = await registry.initAll({} as AdapterContext);

    expect(results).toEqual([
      { id: 'failed', ok: false, err: failure },
      { id: 'healthy', ok: true },
    ]);
    expect(results[0]?.err).toBe(failure);
    expect(registry.isReady('failed')).toBe(false);
    expect(registry.isReady('healthy')).toBe(true);
    expect(diagnostics.observe).toHaveBeenCalledWith('init', 2, 1, 41);
  });
});
