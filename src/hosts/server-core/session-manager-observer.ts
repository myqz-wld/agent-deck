import type { JsonValue } from '@contracts/index';
import {
  insertTokenUsageEvent,
  type TokenUsageRepo,
} from '@main/store/token-usage-repo';
import {
  persistContextUsage,
  resetContextUsageForCompaction,
} from '@main/session/context-window/ingest';
import { sessionRepo } from '@main/store/session-repo';
import { sessionChange } from './provider-host-common';
import type { ServerCoreProviderEventBus } from './provider-event-bus';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionManagerObserver } from './session-manager';

export function appendServerCoreChangeSafely(
  metadata: ServerCoreRuntimeMetadataStore,
  diagnostics: ServerCoreRuntimeDiagnostics,
  kind: string,
  entityId: string | null,
  payload: JsonValue,
): void {
  try {
    metadata.appendChange(kind, entityId, payload);
  } catch {
    try { diagnostics.warn('Core change publication failed'); } catch {}
  }
}

export function createServerCoreSessionManagerObserver(input: {
  diagnostics: ServerCoreRuntimeDiagnostics;
  metadata: ServerCoreRuntimeMetadataStore;
  reviewEvents: ServerCoreProviderEventBus;
  tokenUsage: TokenUsageRepo;
}): ServerCoreSessionManagerObserver {
  const append = (kind: string, entityId: string | null, payload: JsonValue): void =>
    appendServerCoreChangeSafely(
      input.metadata,
      input.diagnostics,
      kind,
      entityId,
      payload,
    );
  return Object.freeze({
    eventPersisted: (event, eventId) => {
      input.reviewEvents.emit(event);
      append('event.persisted', event.sessionId, {
        adapterId: event.agentId,
        eventId,
        kind: event.kind,
        timestamp: event.ts,
      });
    },
    tokenUsageObserved: (event) => {
      try {
        if (!insertTokenUsageEvent(input.tokenUsage, event)) return;
        append('usage.tokens.changed', event.sessionId, {
          adapterId: event.agentId,
          timestamp: event.ts,
        });
      } catch (error) {
        try { input.diagnostics.warn('Server Core token usage persistence failed', {}, error); }
        catch {}
      }
    },
    contextUsageObserved: (event) => {
      try {
        persistContextUsage(event);
        const session = sessionRepo.get(event.sessionId);
        if (session) append('session.context.changed', event.sessionId, {
          adapterId: event.agentId,
          timestamp: event.ts,
        });
      } catch (error) {
        try { input.diagnostics.warn('Server Core context usage persistence failed', {}, error); }
        catch {}
      }
    },
    contextCompactionObserved: (event) => {
      try {
        resetContextUsageForCompaction(event);
        append('session.context.changed', event.sessionId, {
          adapterId: event.agentId,
          timestamp: event.ts,
        });
      } catch (error) {
        try { input.diagnostics.warn('Server Core context compaction persistence failed', {}, error); }
        catch {}
      }
    },
    sessionUpdated: (session) => append(
      'session.updated', session.id, sessionChange(session),
    ),
    sessionRemoved: (sessionId) => append('session.removed', sessionId, null),
    sessionRenamed: (fromId, toId) => append(
      'session.renamed', toId, { fromId, toId },
    ),
    warning: () => {
      try { input.diagnostics.warn('Server Core session lifecycle warning'); } catch {}
    },
  });
}
