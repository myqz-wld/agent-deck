import type { GrokCreateOpts } from '@main/adapters/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';

import type { GrokRuntime } from './runtime-types';
import { createGrokTranslationState } from './translate';

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
    agentProfileName: opts.grokAgentName ?? existing?.agentProfileName ?? null,
    agentProfileSource: opts.grokAgentSource ?? existing?.agentProfileSource ?? null,
    agentPluginDir: opts.grokPluginDir ?? existing?.agentPluginDir ?? null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
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
    agentProfileName: record.agentProfileName ?? null,
    agentProfileSource: record.agentProfileSource ?? null,
    agentPluginDir: record.agentPluginDir ?? null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
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
  const updated = sessionRepo.get(runtime.applicationSessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}
