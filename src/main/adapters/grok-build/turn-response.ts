import type { Usage } from '@agentclientprotocol/sdk';

import type {
  GrokExtensionNotification,
  GrokTurnUsage,
} from './extension';
import type { GrokLivePromptOutcome } from './live-prompt-completion';
import { persistGrokUsageWatermark } from './runtime-factory';
import type { GrokRuntime } from './runtime-types';
import type { GrokTurnQueueOptions } from './turn-queue-types';
import {
  completeGrokTurnLiveRate,
  flushGrokTextUpdates,
  markGrokStandardUsageEmitted,
  translateGrokTurnUsage,
  translateGrokUsage,
  waitForGrokStandardUsage,
} from './translate';

export function responseFromGrokLiveOutcome(
  runtime: GrokRuntime,
  outcome: GrokLivePromptOutcome,
  options: Pick<GrokTurnQueueOptions, 'emitEvent'>,
): {
  stopReason: string;
  usage?: Usage | null;
  _meta?: Record<string, unknown> | null;
} {
  if (outcome.kind === 'response') return outcome.response;
  if (!runtime.translation.assistantObservedForCurrentTurn) {
    const error = outcome.notification.agentResult?.trim()
      ? outcome.notification.agentResult
      : outcome.notification.stopReason === 'rate_limit'
        ? 'Grok Build 请求触发速率限制，请稍后重试。'
        : null;
    if (error) {
      options.emitEvent(runtime.applicationSessionId, 'message', {
        text: error,
        role: 'assistant',
        error: true,
      });
    }
  }
  return {
    stopReason: outcome.notification.stopReason,
    usage: null,
  };
}

export async function finalizeGrokAcpResponse(
  runtime: GrokRuntime,
  response: {
    stopReason: string;
    usage?: Usage | null;
    _meta?: Record<string, unknown> | null;
  },
  options: Pick<GrokTurnQueueOptions, 'emit' | 'emitEvent'>,
): Promise<void> {
  for (const event of flushGrokTextUpdates(
    runtime.applicationSessionId,
    runtime.translation,
  )) options.emit(event);
  const previousWatermark = runtime.translation.lastUsage;
  const completion = completionFromPromptResponse(response);
  const usageEvent = completion
    ? translateGrokTurnUsage(
        runtime.applicationSessionId,
        runtime.model,
        completion,
        runtime.translation,
      )
    : translateGrokUsage(
        runtime.applicationSessionId,
        runtime.model,
        response.usage,
        runtime.translation,
      );
  if (usageEvent) {
    if (runtime.translation.extensionUsageForCurrentTurn && !runtime.closed) {
      options.emit(usageEvent);
      completeRateFromEvent(
        runtime,
        usageEvent.payload,
        completion?.update?.usage?.apiDurationMs,
      );
    } else if (await waitForGrokStandardUsage(runtime.translation) && !runtime.closed) {
      options.emit(usageEvent);
      markGrokStandardUsageEmitted(runtime.translation, usageEvent);
      completeRateFromEvent(
        runtime,
        usageEvent.payload,
        completion?.update?.usage?.apiDurationMs,
      );
    }
  } else if (runtime.translation.lastUsage !== previousWatermark) {
    persistGrokUsageWatermark(runtime);
  }
  if (!runtime.closed) {
    options.emitEvent(runtime.applicationSessionId, 'finished', {
      ok: response.stopReason === 'end_turn',
      subtype: response.stopReason,
    });
  }
}

function completionFromPromptResponse(response: {
  stopReason: string;
  _meta?: Record<string, unknown> | null;
}): GrokExtensionNotification | null {
  const meta = response._meta;
  const usage = meta?.usage;
  const promptId = meta?.promptId;
  if (
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage) ||
    typeof promptId !== 'string' ||
    !promptId.trim()
  ) return null;
  return {
    sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : undefined,
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: promptId,
      stop_reason: response.stopReason,
      usage: usage as GrokTurnUsage,
    },
  };
}

function completeRateFromEvent(
  runtime: GrokRuntime,
  payload: unknown,
  durationMs?: number,
): void {
  const outputTokens =
    payload && typeof payload === 'object'
      ? (payload as { outputTokens?: unknown }).outputTokens
      : null;
  completeGrokTurnLiveRate(
    runtime.translation,
    typeof outputTokens === 'number' ? outputTokens : 0,
    durationMs,
  );
}
