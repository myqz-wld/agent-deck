import { grokNativeConsumersIdle } from './grok';
import { ComponentRefreshGate } from './gate';
import { componentRefreshText, type SessionComponentRefreshStatus } from '@shared/session-component-refresh';
import type { AgentEvent, SessionAdapterId } from '@shared/types';
import type { InternalSession as ClaudeSession } from '../claude-code/sdk-bridge/types';
import type { InternalSession as CodexSession } from '../codex-cli/sdk-bridge/types';
import type { GrokRuntime } from '../grok-build/runtime-types';

export const refreshFeedback = (
  emit: (event: AgentEvent) => void, sessionId: string, agentId: SessionAdapterId,
) => (status: SessionComponentRefreshStatus): void => emit({
  sessionId, agentId, kind: 'message', ts: Date.now(), source: 'sdk',
  payload: { role: 'system', text: componentRefreshText(status), applicationAction: 'component-refresh', componentRefresh: status },
});

export function claudeRefreshGate(
  session: ClaudeSession, current: () => boolean, emit: (event: AgentEvent) => void,
): ComponentRefreshGate {
  if (session.componentRefresh && !session.componentRefresh.reusable && !session.componentRefresh.blocked) session.componentRefresh = undefined;
  const query = session.query; const cwd = session.cwd;
  return session.componentRefresh ??= new ComponentRefreshGate({
    current: () => current() && session.query === query && session.cwd === cwd && !session.expectedClose,
    idle: () => !session.userTurnInFlight && !session.submittingUserMessage && !session.activeCompaction
      && !session.retireRequested && session.cwdTransitionGeneration == null && !session.providerInputClosed
      && session.pendingPermissions.size === 0 && session.pendingAskUserQuestions.size === 0
      && session.pendingExitPlanModes.size === 0 && session.toolUseNames.size === 0
      && [...(session.backgroundTasks?.values() ?? [])].every(task =>
        ['completed', 'failed', 'stopped'].includes(task.snapshot.status)),
    wake: () => { const notify = session.notify; session.notify = null; notify?.(); },
    emit: refreshFeedback(emit, session.applicationSid, 'claude-code'),
  });
}

export function codexRefreshGate(
  session: CodexSession, current: () => boolean, emit: (event: AgentEvent) => void, wake: () => void, nativeIdle: () => boolean = () => true,
): ComponentRefreshGate {
  if (session.componentRefresh && !session.componentRefresh.reusable && !session.componentRefresh.blocked) session.componentRefresh = undefined;
  const thread = session.thread; const cwd = session.cwd;
  return session.componentRefresh ??= new ComponentRefreshGate({
    current: () => current() && session.thread === thread && session.cwd === cwd && !session.intentionallyClosed,
    idle: () => nativeIdle() && !session.currentTurn && !session.submittingUserMessage && !session.activeControlCommand
      && !session.retireAfterCurrentTurn && session.cwdTransitionGeneration == null && session.pendingPermissions.size === 0,
    wake, emit: refreshFeedback(emit, session.applicationSid, 'codex-cli'),
  });
}

export function grokRefreshGate(
  runtime: GrokRuntime, current: () => boolean, emit: (event: AgentEvent) => void, wake: () => void,
): ComponentRefreshGate {
  if (runtime.componentRefresh && !runtime.componentRefresh.reusable && !runtime.componentRefresh.blocked) runtime.componentRefresh = undefined;
  const process = runtime.process; const cwd = runtime.cwd; const nativeId = runtime.nativeSessionId;
  return runtime.componentRefresh ??= new ComponentRefreshGate({
    current: () => current() && runtime.process === process && runtime.nativeSessionId === nativeId
      && runtime.cwd === cwd && !runtime.closed && !runtime.disposed,
    idle: () => runtime.ready && !runtime.running && !runtime.submittingMessage && !runtime.sealed
      && !runtime.restartingSandbox && !runtime.runtimeMutationInProgress && runtime.cwdTransitionGeneration == null
      && runtime.pendingPermissions.size === 0,
    idleCheck: signal => grokNativeConsumersIdle(runtime, signal),
    wake, emit: refreshFeedback(emit, runtime.applicationSessionId, 'grok-build'),
  });
}
