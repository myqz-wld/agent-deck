import type { PromptResponse } from '@agentclientprotocol/sdk';

import type { GrokPromptCompleteNotification } from './extension';
import type { GrokRuntime } from './runtime-types';

const DEFAULT_PROMPT_RESPONSE_GRACE_MS = 250;

export type GrokLivePromptOutcome =
  | { kind: 'response'; response: PromptResponse }
  | {
      kind: 'prompt-complete';
      notification: CorrelatedPromptComplete;
    };

type CorrelatedPromptComplete = GrokPromptCompleteNotification & {
  stopReason: string;
  turnId: number;
};

interface ActivePromptCompletion {
  resolve: (notification: CorrelatedPromptComplete) => void;
  turnId: number;
}

type PromptResponseSettlement =
  | { kind: 'response'; response: PromptResponse }
  | { kind: 'response-error'; error: unknown };

/**
 * Races the standard PromptResponse with Grok's live prompt-complete ACP rail.
 *
 * Grok emits prompt_complete after all model updates but before constructing the
 * PromptResponse. Correlating the provider echo of our numeric turnId lets this
 * terminal safely finish the exact in-flight turn when that final RPC response
 * never reaches the client.
 */
export class GrokLivePromptCompletion {
  private readonly active = new WeakMap<GrokRuntime, ActivePromptCompletion>();
  private nextTurnId = 1;

  constructor(
    private readonly responseGraceMs = DEFAULT_PROMPT_RESPONSE_GRACE_MS,
  ) {}

  async run(
    runtime: GrokRuntime,
    request: (turnId: number) => Promise<PromptResponse>,
  ): Promise<GrokLivePromptOutcome> {
    this.active.delete(runtime);
    const turnId = this.allocateTurnId();
    let resolve!: (notification: CorrelatedPromptComplete) => void;
    const promise = new Promise<CorrelatedPromptComplete>((nextResolve) => {
      resolve = nextResolve;
    });
    const active = { resolve, turnId };
    this.active.set(runtime, active);

    try {
      const response: Promise<PromptResponseSettlement> = request(turnId).then(
        (value) => ({
          kind: 'response' as const,
          response: value,
        }),
        (error) => ({ kind: 'response-error' as const, error }),
      );
      const terminal = promise.then((notification) => ({
        kind: 'prompt-complete' as const,
        notification,
      }));
      const first = await Promise.race([
        response,
        terminal,
      ]);
      if (first.kind === 'response-error') throw first.error;
      if (first.kind === 'response') return first;

      const promptResponse = await waitForPromptResponse(
        response,
        this.responseGraceMs,
      );
      return promptResponse?.kind === 'response'
        ? promptResponse
        : first;
    } finally {
      if (this.active.get(runtime) === active) this.active.delete(runtime);
    }
  }

  observe(
    runtime: GrokRuntime,
    notification: GrokPromptCompleteNotification,
  ): boolean {
    const active = this.active.get(runtime);
    if (
      !active ||
      notification.turnId !== active.turnId ||
      !notification.stopReason ||
      (
        notification.sessionId !== undefined &&
        notification.sessionId !== runtime.nativeSessionId
      )
    ) return false;
    active.resolve({
      ...notification,
      stopReason: notification.stopReason,
      turnId: active.turnId,
    });
    return true;
  }

  private allocateTurnId(): number {
    const turnId = this.nextTurnId;
    this.nextTurnId =
      turnId >= Number.MAX_SAFE_INTEGER ? 1 : turnId + 1;
    return turnId;
  }
}

function waitForPromptResponse(
  response: Promise<PromptResponseSettlement>,
  timeoutMs: number,
): Promise<PromptResponseSettlement | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    response.then((settlement) => {
      clearTimeout(timer);
      resolve(settlement);
    });
  });
}
