import type { GrokCreateOpts } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

import {
  NOOP_GROK_BRIDGE_RUNTIME_HOST,
  type GrokBridgeRuntimeHost,
} from './bridge-runtime-core';
import {
  NOOP_GROK_LIVE_RATE_OBSERVER,
  type GrokLiveRateObserver,
} from './live-token-rate-core';
import type { GrokRuntime } from './runtime-types';
import { createGrokTranslationState } from './translate';

export function createGrokRuntime(
  applicationSessionId: string,
  opts: GrokCreateOpts,
  existing: SessionRecord | null,
  liveRateObserver: GrokLiveRateObserver = NOOP_GROK_LIVE_RATE_OBSERVER,
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
    currentTurnController: null,
    interruptRequested: false,
    cwdTransitionGeneration: null,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: Boolean(existing?.cliSessionId),
    model: opts.model ?? existing?.model ?? null,
    runtimeIdentity: null,
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
      liveRateObserver,
    }),
  };
}

export function recoverGrokRuntime(
  record: SessionRecord,
  liveRateObserver: GrokLiveRateObserver = NOOP_GROK_LIVE_RATE_OBSERVER,
): GrokRuntime {
  return {
    applicationSessionId: record.id,
    nativeSessionId: record.cliSessionId ?? null,
    cwd: record.cwd,
    process: null,
    ready: false,
    queue: [],
    submittingMessage: null,
    running: false,
    currentTurnController: null,
    interruptRequested: false,
    cwdTransitionGeneration: null,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: true,
    model: record.model ?? null,
    runtimeIdentity: null,
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
      liveRateObserver,
    }),
  };
}

export function persistGrokRuntimeMetadata(
  runtime: GrokRuntime,
  host: GrokBridgeRuntimeHost = NOOP_GROK_BRIDGE_RUNTIME_HOST,
): void {
  const model =
    runtime.modelOverride === undefined ? runtime.model : runtime.modelOverride;
  const thinking =
    runtime.thinkingOverride === undefined
      ? runtime.thinking
      : runtime.thinkingOverride;
  host.transaction(() => {
    host.records.setAgentRuntimeProfile(runtime.applicationSessionId, {
      agentProfileName: runtime.agentProfileName,
      agentProfileSource: runtime.agentProfileSource,
      agentPluginDir: runtime.agentPluginDir,
    });
    host.records.setRuntimeProvider(runtime.applicationSessionId, null);
    host.records.setModel(runtime.applicationSessionId, model);
    host.records.setThinking(runtime.applicationSessionId, thinking);
    host.records.setSessionMode(
      runtime.applicationSessionId,
      runtime.sessionMode,
    );
    host.records.setGrokSandbox(
      runtime.applicationSessionId,
      runtime.grokSandbox,
    );
  });
  host.publishSessionUpdated(runtime.applicationSessionId);
}

/** Commit the three persisted Grok model-selection columns as one SQLite transaction. */
export function persistGrokModelOptions(
  sessionId: string,
  model: string | null,
  thinking: string | null,
  host: GrokBridgeRuntimeHost = NOOP_GROK_BRIDGE_RUNTIME_HOST,
): void {
  host.transaction(() => {
    host.records.setModel(sessionId, model);
    host.records.setThinking(sessionId, thinking);
    host.records.setRuntimeProvider(sessionId, null);
  });
  host.publishSessionUpdated(sessionId);
}

export function persistGrokSessionMode(
  sessionId: string,
  mode: GrokRuntime['sessionMode'],
  host: GrokBridgeRuntimeHost = NOOP_GROK_BRIDGE_RUNTIME_HOST,
): void {
  host.records.setSessionMode(sessionId, mode);
  host.publishSessionUpdated(sessionId);
}

/** Best-effort durability for cumulative ACP usage; accounting must not break the turn. */
export function persistGrokUsageWatermark(
  runtime: GrokRuntime,
  host: GrokBridgeRuntimeHost = NOOP_GROK_BRIDGE_RUNTIME_HOST,
): void {
  try {
    host.records.setGrokUsageWatermark(
      runtime.applicationSessionId,
      runtime.translation.lastUsage,
    );
  } catch (err) {
    host.diagnostics.scope('grok-runtime').warn(
      `[grok-runtime] failed to persist usage watermark for ${runtime.applicationSessionId}`,
      err,
    );
  }
}
