import type { Usage } from '@agentclientprotocol/sdk';

import type {
  GrokExtensionNotification,
  GrokTurnUsage,
} from './extension';
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
      completeRateFromEvent(runtime, usageEvent.payload);
    } else if (await waitForGrokStandardUsage(runtime.translation) && !runtime.closed) {
      options.emit(usageEvent);
      markGrokStandardUsageEmitted(runtime.translation, usageEvent);
      completeRateFromEvent(runtime, usageEvent.payload);
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

function completeRateFromEvent(runtime: GrokRuntime, payload: unknown): void {
  const outputTokens =
    payload && typeof payload === 'object'
      ? (payload as { outputTokens?: unknown }).outputTokens
      : null;
  completeGrokTurnLiveRate(
    runtime.translation,
    typeof outputTokens === 'number' ? outputTokens : 0,
  );
}
