import type { AgentAdapter } from '@main/adapters/types';
import type { AdapterInitResult } from '@main/adapters/registry-core';

export interface ServerCoreHookAdapterRegistry {
  get(adapterId: string): AgentAdapter | undefined;
}

function installed(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (value as { installed?: unknown }).installed === true;
}

/** Installs Core-owned hooks into the private provider home after adapter route registration. */
export async function installServerCoreProviderHooks(
  results: readonly AdapterInitResult[],
  registry: ServerCoreHookAdapterRegistry,
): Promise<void> {
  const failures: unknown[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    const adapter = registry.get(result.id);
    if (!adapter?.installIntegration) {
      failures.push(new Error(`Provider ${result.id} does not expose managed hooks`));
      continue;
    }
    try {
      const status = await adapter.installIntegration({ scope: 'user' });
      if (!installed(status)) throw new Error('Managed hook installation was not confirmed');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Server Core managed hook installation failed');
  }
}
