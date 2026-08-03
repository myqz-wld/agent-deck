import type { SessionUpdate } from '@agentclientprotocol/sdk';
import log from '@main/utils/logger';

import type { GrokRuntime } from './runtime-types';

const logger = log.scope('grok-turn-watchdog');

export const DEFAULT_GROK_FIRST_MODEL_EVENT_TIMEOUT_MS = 90_000;

interface ActiveWatchdog {
  startedAt: number;
  timer: NodeJS.Timeout;
}

export class GrokFirstModelEventTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(grokFirstModelEventTimeoutMessage(timeoutMs));
    this.name = 'GrokFirstModelEventTimeoutError';
  }
}

/**
 * Bounds the accepted-prompt phase without imposing a deadline on a healthy long-running turn.
 * The timer is armed before the ACP request is written so same-batch notifications cannot race it.
 */
export class GrokFirstModelEventWatchdog {
  private readonly active = new WeakMap<GrokRuntime, ActiveWatchdog>();

  constructor(
    private readonly timeoutMs = DEFAULT_GROK_FIRST_MODEL_EVENT_TIMEOUT_MS,
  ) {}

  async run<T>(runtime: GrokRuntime, request: () => Promise<T>): Promise<T> {
    this.clear(runtime);
    const startedAt = Date.now();
    let rejectTimeout!: (error: Error) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      const current = this.active.get(runtime);
      if (!current || current.timer !== timer) return;
      this.active.delete(runtime);
      logger.warn('[grok-turn-watchdog] first model event timeout', {
        event: 'grok_turn_watchdog',
        phase: 'timeout',
        sessionId: runtime.applicationSessionId,
        nativeSessionId: runtime.nativeSessionId,
        elapsedMs: Math.max(0, Date.now() - current.startedAt),
        timeoutMs: this.timeoutMs,
        processPid: runtime.process?.child?.pid ?? null,
      });
      rejectTimeout(new GrokFirstModelEventTimeoutError(this.timeoutMs));
    }, this.timeoutMs);
    timer.unref?.();
    this.active.set(runtime, { startedAt, timer });
    logger.debug('[grok-turn-watchdog] armed', {
      event: 'grok_turn_watchdog',
      phase: 'armed',
      sessionId: runtime.applicationSessionId,
      nativeSessionId: runtime.nativeSessionId,
      timeoutMs: this.timeoutMs,
      processPid: runtime.process?.child?.pid ?? null,
    });

    try {
      return await Promise.race([request(), timeout]);
    } finally {
      this.clear(runtime);
    }
  }

  observe(runtime: GrokRuntime, update: SessionUpdate): void {
    if (!isGrokModelActivity(update)) return;
    const current = this.active.get(runtime);
    if (!current) return;
    const acceptance = runtime.trustedContinuationAcceptance;
    if (acceptance && !isGrokTrustedContinuationModelActivity(update)) return;
    if (acceptance) {
      delete runtime.trustedContinuationAcceptance;
      acceptance.acceptModelActivity();
    }
    this.clear(runtime);
    logger.debug('[grok-turn-watchdog] first model event received', {
      event: 'grok_turn_watchdog',
      phase: 'first_model_event',
      sessionId: runtime.applicationSessionId,
      nativeSessionId: runtime.nativeSessionId,
      elapsedMs: Math.max(0, Date.now() - current.startedAt),
      updateType: update.sessionUpdate,
    });
  }

  clear(runtime: GrokRuntime): void {
    const current = this.active.get(runtime);
    if (!current) return;
    clearTimeout(current.timer);
    this.active.delete(runtime);
  }
}

/** Echoed input and configuration/lifecycle notifications do not prove model progress. */
export function isGrokModelActivity(update: SessionUpdate): boolean {
  return update.sessionUpdate !== 'user_message_chunk'
    && update.sessionUpdate !== 'available_commands_update'
    && update.sessionUpdate !== 'current_mode_update'
    && update.sessionUpdate !== 'config_option_update'
    && update.sessionUpdate !== 'session_info_update';
}

/** Trusted readiness needs positive model evidence; usage/config and future update types fail closed. */
export function isGrokTrustedContinuationModelActivity(update: SessionUpdate): boolean {
  return update.sessionUpdate === 'agent_message_chunk'
    || update.sessionUpdate === 'agent_thought_chunk'
    || update.sessionUpdate === 'tool_call'
    || update.sessionUpdate === 'tool_call_update'
    || update.sessionUpdate === 'plan'
    || update.sessionUpdate === 'plan_update'
    || update.sessionUpdate === 'plan_removed';
}

export function grokFirstModelEventTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return (
    `Grok Build 已接受 prompt，但 ${seconds} 秒内没有产生首个 model 事件。` +
    'Agent Deck 已中断该 turn 并回收 ACP 连接；为避免重复副作用，不会自动重放这条用户消息。'
  );
}
