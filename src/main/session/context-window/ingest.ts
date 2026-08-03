import type {
  AgentEvent,
  ContextRuntimeIdentity,
  ContextWindowObservationSource,
  SessionContextUsageUpdate,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { ObserveContextWindowInput } from '@main/store/context-window-observation-repo';
import { resolveContextRuntimeIdentity } from './identity';

/** Persist current-context telemetry without adding it to the activity timeline. */
export function persistContextUsage(event: AgentEvent): void {
  const raw =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!raw) return;
  const runtimeIdentity = contextUsageRuntimeIdentity(event, raw.runtimeIdentity);
  const update: SessionContextUsageUpdate = { runtimeIdentity };
  if (
    raw.usedTokens === null ||
    (typeof raw.usedTokens === 'number' &&
      Number.isFinite(raw.usedTokens) &&
      raw.usedTokens >= 0)
  ) {
    update.usedTokens =
      raw.usedTokens === null ? null : Math.trunc(raw.usedTokens);
  }
  if (
    raw.windowTokens === null ||
    (typeof raw.windowTokens === 'number' &&
      Number.isFinite(raw.windowTokens) &&
      raw.windowTokens > 0)
  ) {
    update.windowTokens =
      raw.windowTokens === null ? null : Math.trunc(raw.windowTokens);
  }
  if (update.usedTokens === undefined && update.windowTokens === undefined) return;
  const source = contextWindowObservationSource(raw.capacitySource);
  const observation: ObserveContextWindowInput | undefined =
    runtimeIdentity &&
    source &&
    typeof update.windowTokens === 'number'
      ? {
          identity: runtimeIdentity,
          windowTokens: update.windowTokens,
          source,
          observedAt: event.ts,
          originSessionId: event.sessionId,
        }
      : undefined;
  persistContextUsageUpdate(event.sessionId, update, event.ts, observation);
}

/** A compaction start invalidates the used count but preserves the current runtime/window. */
export function resetContextUsageForCompaction(event: AgentEvent): void {
  persistContextUsageUpdate(event.sessionId, { usedTokens: null }, event.ts);
}

function contextUsageRuntimeIdentity(
  event: AgentEvent,
  value: unknown,
): ContextRuntimeIdentity | null {
  if (event.source !== 'sdk') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    event.agentId !== 'claude-code' &&
    event.agentId !== 'codex-cli' &&
    event.agentId !== 'grok-build'
  ) return null;
  const raw = value as Record<string, unknown>;
  const resolved = resolveContextRuntimeIdentity({
    adapter: event.agentId,
    runtimeProvider:
      typeof raw.runtimeProvider === 'string' ? raw.runtimeProvider : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    capacityConfigFingerprint:
      typeof raw.capacityConfigFingerprint === 'string'
        ? raw.capacityConfigFingerprint
        : null,
  });
  return resolved.status === 'concrete' ? resolved.identity : null;
}

function contextWindowObservationSource(
  value: unknown,
): ContextWindowObservationSource | null {
  return value === 'runtime-usage' ||
    value === 'runtime-metadata' ||
    value === 'effective-config'
    ? value
    : null;
}

function persistContextUsageUpdate(
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
  observation?: ObserveContextWindowInput,
): void {
  const contextUsage = sessionRepo.updateContextUsage(
    sessionId,
    update,
    updatedAt,
    observation,
  );
  if (!contextUsage) return;
  const record = sessionRepo.get(sessionId);
  if (record) eventBus.emit('session-upserted', record);
}
