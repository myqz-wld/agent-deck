import type { GrokCreateOpts } from '@main/adapters/types';
import { eventBus } from '@main/event-bus';
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
    thinking: opts.reasoningEffort ?? existing?.thinking ?? null,
    sessionMode: opts.sessionMode ?? existing?.sessionMode ?? null,
    grokSandbox:
      opts.grokSandbox !== undefined
        ? opts.grokSandbox
        : existing?.grokSandbox ?? null,
    restartingSandbox: false,
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
    thinking: record.thinking ?? null,
    sessionMode: record.sessionMode ?? null,
    grokSandbox: record.grokSandbox ?? null,
    restartingSandbox: false,
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
  sessionRepo.setAgentRuntimeProfile(runtime.applicationSessionId, {
    agentProfileName: runtime.agentProfileName,
    agentProfileSource: runtime.agentProfileSource,
    agentPluginDir: runtime.agentPluginDir,
  });
  if (runtime.model) sessionRepo.setModel(runtime.applicationSessionId, runtime.model);
  if (runtime.thinking) {
    sessionRepo.setThinking(runtime.applicationSessionId, runtime.thinking);
  }
  if (runtime.sessionMode) {
    sessionRepo.setSessionMode(runtime.applicationSessionId, runtime.sessionMode);
  }
  sessionRepo.setGrokSandbox(runtime.applicationSessionId, runtime.grokSandbox);
  const updated = sessionRepo.get(runtime.applicationSessionId);
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
