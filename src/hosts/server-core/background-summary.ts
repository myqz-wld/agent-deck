import type { LifecycleComponent } from '@composition/index';
import type { AdapterRegistryClass } from '@main/adapters/registry-core';
import { eventBus } from '@main/event-bus';
import {
  Summarizer,
  type SummarizerSettingKey,
} from '@main/session/summarizer/core';
import type { AppSettings } from '@shared/types';

import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { appendServerCoreChangeSafely } from './session-manager-observer';

/** Shared summary engine bound to the authoritative Relay/Full repository and provider registry. */
export class ServerCoreSummaryService implements LifecycleComponent {
  readonly name = 'server-core-summaries';
  private readonly summarizer: Summarizer;

  constructor(input: {
    readonly settings: ServerCoreProviderSettings;
    readonly registry: AdapterRegistryClass;
    readonly metadata: ServerCoreRuntimeMetadataStore;
    readonly diagnostics: ServerCoreRuntimeDiagnostics;
  }) {
    this.summarizer = new Summarizer({
      settings: {
        get: <K extends SummarizerSettingKey>(key: K): AppSettings[K] =>
          input.settings[key] as AppSettings[K],
      },
      registry: input.registry,
      bus: eventBus,
      onSummaryAdded: (summary) => appendServerCoreChangeSafely(
        input.metadata,
        input.diagnostics,
        'summary.added',
        summary.sessionId,
        {
          generationSource: summary.generationSource,
          summaryId: summary.id,
          timestamp: summary.ts,
          trigger: summary.trigger,
        },
      ),
    });
  }

  async start(): Promise<void> {
    this.summarizer.start();
    await this.summarizer.scanAll();
  }

  async stop(): Promise<void> {
    await this.summarizer.stop();
  }
}
