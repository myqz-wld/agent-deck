import { errorText } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';
import type { GrokTurnQueueOptions } from './turn-queue-types';

export function grokTurnBoundaryBlocked(runtime: GrokRuntime): boolean {
  return runtime.running || runtime.closed || runtime.restartingSandbox ||
    !runtime.ready || runtime.submittingMessage != null ||
    runtime.cwdTransitionGeneration != null || Boolean(runtime.runtimeMutationInProgress);
}

/** Apply staged process-level settings before the queue can claim the next Grok turn. */
export async function prepareGrokNextTurn(
  runtime: GrokRuntime,
  options: Pick<GrokTurnQueueOptions, 'beforeNextTurn' | 'emitEvent'>,
): Promise<boolean> {
  if (grokTurnBoundaryBlocked(runtime)) return false;
  if (runtime.sealed) return true;
  try {
    await options.beforeNextTurn?.(runtime);
  } catch (error) {
    options.emitEvent(runtime.applicationSessionId, 'message', {
      text: `⚠ Grok Build 沙盒未能应用到下一轮：${errorText(error)}`,
      role: 'assistant',
      error: true,
    });
  }
  return !grokTurnBoundaryBlocked(runtime);
}
