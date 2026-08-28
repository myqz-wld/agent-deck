import type { SessionCommandDescriptor } from '@shared/types';
import { sessionCommandInvocation } from '@shared/session-commands';

import { GrokFirstModelEventTimeoutError } from './first-model-event-watchdog';
import { grokTurnFailureReasonFromRequestError } from './native-error';
import { errorText } from './protocol-utils';
import type { GrokRuntime, GrokSubmittingMessage } from './runtime-types';
import type { GrokTurnQueueOptions } from './turn-queue-types';
import { isCancelled } from './turn-queue-helpers';

export function resolveGrokSessionCommand(
  runtime: GrokRuntime,
  text: string,
): SessionCommandDescriptor | null {
  return sessionCommandInvocation(runtime.availableCommands ?? [], text);
}

export function emitSilentGrokSessionCommandOutcome(
  runtime: GrokRuntime,
  command: SessionCommandDescriptor | null,
  outcome: { status: 'completed' } | { status: 'failed'; detail: string },
  options: Pick<GrokTurnQueueOptions, 'emitEvent'>,
): boolean {
  if (!isSilentGrokSessionCommand(runtime, command)) return false;
  const failed = outcome.status === 'failed';
  options.emitEvent(runtime.applicationSessionId, 'message', {
    role: 'system',
    text: failed
      ? `Grok Build /${command.name} 命令失败：${outcome.detail}`
      : `Grok Build /${command.name} 命令完成。`,
    ...(failed ? { error: true } : {}),
    sessionCommandStatus: { command: command.name, status: outcome.status },
  });
  return true;
}

export function isSilentGrokSessionCommand(
  runtime: GrokRuntime,
  command: SessionCommandDescriptor | null,
): command is SessionCommandDescriptor {
  return command !== null &&
    !runtime.closed &&
    !runtime.translation.assistantObservedForCurrentTurn;
}

export async function handleGrokTurnFailure(input: {
  runtime: GrokRuntime;
  error: unknown;
  submitting: GrokSubmittingMessage | null;
  sessionCommand: SessionCommandDescriptor | null;
  options: Pick<GrokTurnQueueOptions, 'closeSession' | 'emitError' | 'emitEvent'>;
  flushText(): void;
}): Promise<void> {
  const { runtime, error, submitting, sessionCommand, options } = input;
  if (runtime.closed) return;
  if (runtime.interruptRequested) {
    input.flushText();
    const silent = isSilentGrokSessionCommand(runtime, sessionCommand);
    options.emitEvent(runtime.applicationSessionId, 'finished', {
      ok: false,
      subtype: 'interrupted',
      ...(silent ? { suppressTimeline: true } : {}),
    });
    emitSilentGrokSessionCommandOutcome(
      runtime,
      sessionCommand,
      { status: 'failed', detail: '操作已中断' },
      options,
    );
    return;
  }
  if (isCancelled(submitting)) return;
  input.flushText();
  const detail = errorText(error);
  const failureReason = grokTurnFailureReasonFromRequestError(error);
  if (isSilentGrokSessionCommand(runtime, sessionCommand)) {
    options.emitEvent(runtime.applicationSessionId, 'finished', {
      ok: false,
      subtype: 'error',
      ...(failureReason ? { failureReason } : {}),
      suppressTimeline: true,
    });
    emitSilentGrokSessionCommandOutcome(
      runtime,
      sessionCommand,
      { status: 'failed', detail },
      options,
    );
  } else {
    const text = `Grok Build 轮次失败：${detail}`;
    if (failureReason) options.emitError(runtime.applicationSessionId, text, failureReason);
    else options.emitError(runtime.applicationSessionId, text);
  }
  if (error instanceof GrokFirstModelEventTimeoutError) {
    await options.closeSession(runtime.applicationSessionId);
  }
}
