import type { Usage } from '@agentclientprotocol/sdk';

import type { RecoveredGrokTurn } from './provider-completion-recovery';
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
  },
  journalTurn: RecoveredGrokTurn | null,
  options: Pick<GrokTurnQueueOptions, 'emit' | 'emitEvent'>,
): Promise<void> {
  for (const event of flushGrokTextUpdates(
    runtime.applicationSessionId,
    runtime.translation,
  )) options.emit(event);
  const previousWatermark = runtime.translation.lastUsage;
  const usageEvent =
    (journalTurn
      ? translateGrokTurnUsage(
          runtime.applicationSessionId,
          runtime.model,
          journalTurn.completion,
          runtime.translation,
        )
      : null)
    ?? translateGrokUsage(
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
