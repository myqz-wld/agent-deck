import type { Usage } from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@shared/types';

import {
  finiteNumber,
  firstModelUsageKey,
  grokExtensionTimestampMs,
  notificationPromptId,
  type GrokExtensionNotification,
  type GrokTurnUsage,
} from './extension';
import {
  beginGrokLiveTokenRate,
  clearGrokLiveTokenRate,
  completeGrokLiveTokenRate,
} from './live-token-rate';
import type {
  GrokTranslationState,
  PendingGrokStandardUsage,
} from './translation-types';

const AGENT_ID = 'grok-build';
const GROK_EXTENSION_USAGE_GRACE_MS = 100;

export function beginGrokTurn(
  state: GrokTranslationState,
  sessionId: string,
  model: string | null,
): void {
  cancelPendingGrokStandardUsage(state);
  state.standardUsageObservedForCurrentTurn = false;
  state.extensionUsageForCurrentTurn = false;
  state.usageSource = 'none';
  beginGrokLiveTokenRate(state, sessionId, model);
}

export function translateGrokUsage(
  sessionId: string,
  model: string | null,
  usage: Usage | null | undefined,
  state: GrokTranslationState,
): AgentEvent | null {
  if (!usage) return null;
  const previous = state.lastUsage;
  state.lastUsage = usage;
  state.standardUsageObservedForCurrentTurn = true;
  if (state.extensionUsageForCurrentTurn || state.usageSource !== 'none') return null;
  return {
    sessionId,
    agentId: AGENT_ID,
    kind: 'token-usage',
    payload: {
      messageId: null,
      model,
      inputTokens: delta(usage.inputTokens, previous?.inputTokens),
      outputTokens: delta(usage.outputTokens, previous?.outputTokens),
      reasoningTokens: delta(usage.thoughtTokens ?? 0, previous?.thoughtTokens ?? 0),
      cacheReadTokens: delta(usage.cachedReadTokens ?? 0, previous?.cachedReadTokens ?? 0),
      cacheCreationTokens: delta(
        usage.cachedWriteTokens ?? 0,
        previous?.cachedWriteTokens ?? 0,
      ),
    },
    ts: Date.now(),
    source: 'sdk',
  };
}

export function translateGrokTurnUsage(
  sessionId: string,
  model: string | null,
  notification: GrokExtensionNotification,
  state: GrokTranslationState,
): AgentEvent | null {
  const update = notification.update;
  if (!update || update.sessionUpdate !== 'turn_completed' || !isGrokTurnUsage(update.usage)) {
    return null;
  }
  if (state.usageSource === 'standard') return null;
  const messageId = notificationPromptId(notification);
  if (!messageId) return null;
  const usage = update.usage;
  if (!hasGrokUsageValues(usage)) return null;
  if (!acceptGrokTurnUsage(state, messageId)) return null;
  if (!state.standardUsageObservedForCurrentTurn) {
    state.lastUsage = addGrokUsageToCumulative(state.lastUsage, usage);
  }
  state.usageSource = 'extension';
  cancelPendingGrokStandardUsage(state);
  return {
    sessionId,
    agentId: AGENT_ID,
    kind: 'token-usage',
    payload: {
      messageId,
      model: model?.trim() || firstModelUsageKey(usage),
      inputTokens: nonNegativeUsageValue(usage.inputTokens),
      outputTokens: nonNegativeUsageValue(usage.outputTokens),
      reasoningTokens: nonNegativeUsageValue(usage.reasoningTokens ?? usage.thoughtTokens),
      cacheReadTokens: nonNegativeUsageValue(usage.cachedReadTokens),
      cacheCreationTokens: 0,
    },
    ts: grokExtensionTimestampMs(notification),
    source: 'sdk',
  };
}

export function waitForGrokStandardUsage(
  state: GrokTranslationState,
  graceMs = GROK_EXTENSION_USAGE_GRACE_MS,
): Promise<boolean> {
  if (state.usageSource === 'extension') return Promise.resolve(false);
  if (state.pendingStandardUsage) {
    cancelPendingGrokStandardUsage(state);
  }
  return new Promise((resolve) => {
    const pending: PendingGrokStandardUsage = {
      resolve: (emit) => {
        if (state.pendingStandardUsage !== pending) return;
        state.pendingStandardUsage = null;
        clearTimeout(pending.timer);
        if (emit) state.usageSource = 'standard';
        resolve(emit);
      },
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.timer = setTimeout(() => {
      if (state.usageSource === 'extension') {
        pending.resolve(false);
        return;
      }
      pending.resolve(true);
    }, Math.max(0, graceMs));
    state.pendingStandardUsage = pending;
  });
}

export function cancelPendingGrokStandardUsage(state: GrokTranslationState): void {
  const pending = state.pendingStandardUsage;
  if (!pending) return;
  pending.resolve(false);
}

export function acceptGrokTurnUsage(
  state: GrokTranslationState,
  promptId: string,
): boolean {
  if (state.turnUsagePromptIds.has(promptId)) return false;
  state.turnUsagePromptIds.add(promptId);
  state.extensionUsageForCurrentTurn = true;
  if (state.turnUsagePromptIds.size > 512) {
    const oldest = state.turnUsagePromptIds.values().next().value as string | undefined;
    if (oldest) state.turnUsagePromptIds.delete(oldest);
  }
  return true;
}

export function completeGrokTurnLiveRate(
  state: GrokTranslationState,
  outputTokens: number,
  durationMs?: number,
): void {
  completeGrokLiveTokenRate(state, outputTokens, Date.now(), durationMs);
}

export function clearGrokTurnLiveRate(state: GrokTranslationState): void {
  cancelPendingGrokStandardUsage(state);
  clearGrokLiveTokenRate(state);
}

function isGrokTurnUsage(value: unknown): value is GrokTurnUsage {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasGrokUsageValues(usage: GrokTurnUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cachedReadTokens,
    usage.reasoningTokens,
    usage.thoughtTokens,
  ].some((value) => finiteNumber(value) !== null);
}

function nonNegativeUsageValue(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function addGrokUsageToCumulative(previous: Usage | null, usage: GrokTurnUsage): Usage {
  const inputTokens = (previous?.inputTokens ?? 0) + nonNegativeUsageValue(usage.inputTokens);
  const outputTokens = (previous?.outputTokens ?? 0) + nonNegativeUsageValue(usage.outputTokens);
  const thoughtTokens =
    (previous?.thoughtTokens ?? 0) +
    nonNegativeUsageValue(usage.reasoningTokens ?? usage.thoughtTokens);
  const cachedReadTokens =
    (previous?.cachedReadTokens ?? 0) + nonNegativeUsageValue(usage.cachedReadTokens);
  const cachedWriteTokens =
    (previous?.cachedWriteTokens ?? 0) + nonNegativeUsageValue(usage.cachedWriteTokens);
  const totalTokens =
    (previous?.totalTokens ?? 0) +
    nonNegativeUsageValue(
      usage.totalTokens ??
        nonNegativeUsageValue(usage.inputTokens) + nonNegativeUsageValue(usage.outputTokens),
    );
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    thoughtTokens,
    cachedReadTokens,
    cachedWriteTokens,
  };
}

function delta(current: number, previous: number | undefined): number {
  return Math.max(0, current - (previous ?? 0));
}
