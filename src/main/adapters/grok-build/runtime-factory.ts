import type { GrokCreateOpts } from '@main/adapters/types';
import { eventBus } from '@main/event-bus';
import { getDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { SessionRecord } from '@shared/types';

import type { GrokRuntime } from './runtime-types';
import { createGrokTranslationState } from './translate';

const logger = log.scope('grok-runtime');

export function createGrokRuntime(
  applicationSessionId: string,
  opts: GrokCreateOpts,
  existing: SessionRecord | null,
): GrokRuntime {
  return {
    applicationSessionId,
    nativeSessionId: existing?.cliSessionId ?? null,
    cwd: opts.cwd,
    process: null,
    ready: false,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: Boolean(existing?.cliSessionId),
    model: opts.model ?? existing?.model ?? null,
    modelOverride: opts.model ?? existing?.model ?? null,
    nativeDefaultModel: null,
    thinking: opts.reasoningEffort ?? existing?.thinking ?? null,
    thinkingOverride: opts.reasoningEffort ?? existing?.thinking ?? null,
    sessionMode: opts.sessionMode ?? existing?.sessionMode ?? null,
    grokSandbox:
      opts.grokSandbox !== undefined
        ? opts.grokSandbox
        : existing?.grokSandbox ?? null,
    restartingSandbox: false,
    runtimeMutationInProgress: false,
    agentProfileName: opts.grokAgentName ?? existing?.agentProfileName ?? null,
    agentProfileSource: opts.grokAgentSource ?? existing?.agentProfileSource ?? null,
    agentPluginDir: opts.grokPluginDir ?? existing?.agentPluginDir ?? null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState({
      lastUsage: existing?.grokUsageWatermark ?? null,
      standardUsageBaselineReady:
        existing === null || existing.grokUsageWatermark != null,
    }),
  };
}

export function recoverGrokRuntime(record: SessionRecord): GrokRuntime {
  return {
    applicationSessionId: record.id,
    nativeSessionId: record.cliSessionId ?? null,
    cwd: record.cwd,
    process: null,
    ready: false,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: true,
    model: record.model ?? null,
    modelOverride: record.model ?? null,
    nativeDefaultModel: null,
    thinking: record.thinking ?? null,
    thinkingOverride: record.thinking ?? null,
    sessionMode: record.sessionMode ?? null,
    grokSandbox: record.grokSandbox ?? null,
    restartingSandbox: false,
    runtimeMutationInProgress: false,
    agentProfileName: record.agentProfileName ?? null,
    agentProfileSource: record.agentProfileSource ?? null,
    agentPluginDir: record.agentPluginDir ?? null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState({
      lastUsage: record.grokUsageWatermark ?? null,
      standardUsageBaselineReady: record.grokUsageWatermark != null,
    }),
  };
}

export function persistGrokRuntimeMetadata(runtime: GrokRuntime): void {
  const model =
    runtime.modelOverride === undefined ? runtime.model : runtime.modelOverride;
  const thinking =
    runtime.thinkingOverride === undefined
      ? runtime.thinking
      : runtime.thinkingOverride;
  const persist = getDb().transaction(() => {
    sessionRepo.setAgentRuntimeProfile(runtime.applicationSessionId, {
      agentProfileName: runtime.agentProfileName,
      agentProfileSource: runtime.agentProfileSource,
      agentPluginDir: runtime.agentPluginDir,
    });
    sessionRepo.setRuntimeProvider(runtime.applicationSessionId, null);
    sessionRepo.setModel(runtime.applicationSessionId, model);
    sessionRepo.setThinking(runtime.applicationSessionId, thinking);
    sessionRepo.setSessionMode(
      runtime.applicationSessionId,
      runtime.sessionMode,
    );
    sessionRepo.setGrokSandbox(
      runtime.applicationSessionId,
      runtime.grokSandbox,
    );
  });
  persist();
  emitRuntimeUpsert(runtime.applicationSessionId);
}

/** Commit the three persisted Grok model-selection columns as one SQLite transaction. */
export function persistGrokModelOptions(
  sessionId: string,
  model: string | null,
  thinking: string | null,
): void {
  const persist = getDb().transaction(() => {
    sessionRepo.setModel(sessionId, model);
    sessionRepo.setThinking(sessionId, thinking);
    sessionRepo.setRuntimeProvider(sessionId, null);
  });
  persist();
  emitRuntimeUpsert(sessionId);
}

export function persistGrokSessionMode(
  sessionId: string,
  mode: GrokRuntime['sessionMode'],
): void {
  sessionRepo.setSessionMode(sessionId, mode);
  emitRuntimeUpsert(sessionId);
}

function emitRuntimeUpsert(sessionId: string): void {
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/** Best-effort durability for cumulative ACP usage; accounting must not break the turn. */
export function persistGrokUsageWatermark(runtime: GrokRuntime): void {
  try {
    sessionRepo.setGrokUsageWatermark(
      runtime.applicationSessionId,
      runtime.translation.lastUsage,
    );
  } catch (err) {
    logger.warn(
      `[grok-runtime] failed to persist usage watermark for ${runtime.applicationSessionId}`,
      err,
    );
  }
}
