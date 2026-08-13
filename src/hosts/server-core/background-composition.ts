import type { LifecycleComponent } from '@composition/index';
import type { AdapterRegistryClass } from '@main/adapters/registry-core';

import type { ServerCoreProviderHostInput } from './provider-host-common';
import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { ServerCoreCheckpointService } from './background-checkpoints';
import { ServerCoreSummaryService } from './background-summary';

export interface ServerCoreBackgroundComposition {
  refreshContinuation(sessionId: string): Promise<void>;
  bindProviderHost(input: ServerCoreProviderHostInput): readonly LifecycleComponent[];
}

/** Resolves the MCP/checkpoint construction cycle without leaking a partially built service. */
export function createServerCoreBackgroundComposition(input: {
  readonly settings: ServerCoreProviderSettings;
  readonly registry: AdapterRegistryClass;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
}): ServerCoreBackgroundComposition {
  let checkpoints: ServerCoreCheckpointService | null = null;
  let bound = false;
  return Object.freeze({
    refreshContinuation: async (sessionId: string) => {
      await checkpoints?.refreshNow(sessionId);
    },
    bindProviderHost: (providerInput: ServerCoreProviderHostInput) => {
      if (bound) throw new Error('Server Core background services are already bound');
      bound = true;
      const summaries = new ServerCoreSummaryService({
        settings: input.settings,
        registry: input.registry,
        metadata: input.metadata,
        diagnostics: input.diagnostics,
      });
      checkpoints = new ServerCoreCheckpointService(input.settings, providerInput);
      return Object.freeze([summaries, checkpoints]);
    },
  });
}
