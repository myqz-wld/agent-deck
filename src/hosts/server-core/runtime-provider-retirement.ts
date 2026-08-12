import type { AdapterRegistryClass } from '@main/adapters/registry-core';
import type { ServerCoreRepositoryHost } from './repository-host';
import { mapServerCoreConcurrent } from './runtime-concurrency';
import type { ServerCoreProviderGrokContainerPort } from './runtime-provider-container';

const MAX_PROVIDER_RETIREMENTS = 4_096;
const PROVIDER_RETIREMENT_CONCURRENCY = 8;

export function createServerCoreProviderRetirement(options: {
  repositories: ServerCoreRepositoryHost;
  registry: AdapterRegistryClass;
  grokContainer: ServerCoreProviderGrokContainerPort | null;
}): { retireProviders(): Promise<void>; shutdownProviders(): Promise<void> } {
  return {
    retireProviders: async () => {
      const records = options.repositories.sessions.listActiveAndDormant(
        MAX_PROVIDER_RETIREMENTS + 1,
        0,
      );
      if (records.length > MAX_PROVIDER_RETIREMENTS) {
        throw new Error('Provider retirement exceeds its bounded session ceiling');
      }
      await mapServerCoreConcurrent(
        records.filter((record) => record.lifecycle === 'active'),
        PROVIDER_RETIREMENT_CONCURRENCY,
        async (record) => {
          await options.registry.get(record.agentId)?.closeSession?.(record.id);
        },
      );
    },
    shutdownProviders: async () => {
      const failures: unknown[] = (await options.registry.shutdownAll())
        .filter((result) => !result.ok)
        .map((result) => result.err);
      if (options.grokContainer) {
        try { await options.grokContainer.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Provider adapter shutdown failed');
      }
    },
  };
}
