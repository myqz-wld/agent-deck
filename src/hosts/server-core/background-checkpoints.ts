import type { LifecycleComponent } from '@composition/index';
import { getDb } from '@main/store/db';
import { createContextWindowCapacityService } from '@main/session/context-window/service';
import {
  ContinuationCheckpointRefreshService,
} from '@main/session/continuation-context/checkpoint-refresh-service';
import {
  refreshContinuationCheckpointWithDependencies,
} from '@main/session/continuation-context/checkpoint-background-refresh';
import {
  resolveContinuationGeneratorSnapshotFromSettings,
} from '@main/session/continuation-context/resolver-core';
import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreProviderHostInput } from './provider-host-common';
import {
  createServerCoreCheckpointSource,
  estimateServerCoreCheckpointBacklog,
} from './checkpoint-source';
import { createServerCoreCheckpointGenerator } from './checkpoint-generator-host';
import { resolveServerCoreClaudeGatewayProfile } from './provider-claude-host';

/** Relay/Full checkpoint scheduler using the same fold engine and authoritative Core database. */
export class ServerCoreCheckpointService implements LifecycleComponent {
  readonly name = 'server-core-continuation-checkpoints';
  private readonly service: ContinuationCheckpointRefreshService;
  private readonly foreground = new Map<string, Promise<void>>();

  constructor(
    private readonly settings: ServerCoreProviderSettings,
    private readonly providerInput: ServerCoreProviderHostInput,
  ) {
    this.service = new ContinuationCheckpointRefreshService(settings, {
      estimateBacklog: (sessionId, signal) => signal.aborted
        ? null
        : estimateServerCoreCheckpointBacklog(getDb(), sessionId),
      refresh: (request) => this.refresh(request),
    });
  }

  async start(): Promise<void> {
    this.service.start();
  }

  async stop(): Promise<void> {
    await this.service.stop();
    await Promise.allSettled(this.foreground.values());
  }

  /** Refreshes the durable checkpoint before a handoff, coalescing preview/commit work. */
  refreshNow(sessionId: string): Promise<void> {
    const existing = this.foreground.get(sessionId);
    if (existing) return existing;
    const current = this.refreshForeground(sessionId).finally(() => {
      if (this.foreground.get(sessionId) === current) this.foreground.delete(sessionId);
    });
    this.foreground.set(sessionId, current);
    return current;
  }

  private async refreshForeground(sessionId: string): Promise<void> {
    const release = await this.service.acquireForegroundLease(sessionId);
    try {
      const estimate = estimateServerCoreCheckpointBacklog(getDb(), sessionId);
      if (!estimate || estimate.captureRevision <= estimate.checkpointThroughRevision) return;
      await this.refresh({
        sessionId,
        trigger: estimate.saturated ? 'safety' : 'normal',
        snapshot: {
          sessionId,
          sourceEventRevision: estimate.captureRevision,
          checkpointEventRevision: estimate.checkpointThroughRevision,
          uncheckpointedNormalizedTokens: estimate.estimatedTokens,
          rebuildAfterRevision: estimate.rebuildAfterRevision,
          checkpointCreatedAt: estimate.checkpointCreatedAt,
          saturated: estimate.saturated,
        },
      });
    } finally {
      release();
    }
  }

  private refresh(request: Parameters<typeof refreshContinuationCheckpointWithDependencies>[0]) {
    const db = getDb();
    const capacityService = createContextWindowCapacityService(db);
    return refreshContinuationCheckpointWithDependencies(request, {
      db,
      capacityService,
      resolveGenerator: () => resolveContinuationGeneratorSnapshotFromSettings(
        {
          ...this.settings,
          resolveClaudeGatewayProfile: (provider) =>
            resolveServerCoreClaudeGatewayProfile(this.providerInput, provider),
        },
        { capacityService },
      ),
      generatorFactory: (generator) =>
        createServerCoreCheckpointGenerator(this.providerInput, generator),
      openBackgroundSource: async (input) => {
        if (input.signal?.aborted) {
          const error = new Error('Background checkpoint source cancelled');
          error.name = 'AbortError';
          throw error;
        }
        return createServerCoreCheckpointSource(db, input.sessionId);
      },
    });
  }
}
