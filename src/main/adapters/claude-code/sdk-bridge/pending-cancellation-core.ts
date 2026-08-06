import type {
  AgentEvent,
  AskUserQuestionAnswer,
  ExitPlanModeResponse,
} from '@shared/types';
import { AGENT_ID } from './constants';

interface ClearablePendingEntries<Entry> {
  values(): IterableIterator<Entry>;
  clear(): void;
}

interface PendingEntry<Payload, Response> {
  payload: Payload;
  resolver(response: Response): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingRequestPayload {
  requestId: string;
}

interface PermissionCancellationResult {
  behavior: 'deny';
  message: string;
  interrupt: true;
}

export interface ClaudePendingCancellationSession {
  applicationSid: string;
  cliSessionId: string | null;
  pendingPermissions: ClearablePendingEntries<
    PendingEntry<PendingRequestPayload, PermissionCancellationResult>
  >;
  pendingAskUserQuestions: ClearablePendingEntries<
    PendingEntry<PendingRequestPayload, AskUserQuestionAnswer>
  >;
  pendingExitPlanModes: ClearablePendingEntries<
    PendingEntry<PendingRequestPayload, ExitPlanModeResponse>
  >;
  pendingUserMessages: { length: number };
  submittingUserMessage?: unknown | null;
  ignoredUserMessageIds?: { clear(): void };
  acceptedEnqueueFingerprints?: { clear(): void };
  notify: (() => void) | null;
}

export interface ClaudePendingCancellationHost<Session> {
  now(): number;
  cleanupGatewaySandboxSettings(session: Session): void;
  releaseSdkClaim(sessionId: string): void;
  markRecentlyDeleted(sessionId: string): void;
}

export function cancelClaudePendingAndEmitCore<
  Session extends ClaudePendingCancellationSession,
>(
  internal: Session,
  realIdForEmit: string,
  emit: (event: AgentEvent) => void,
  host: Pick<ClaudePendingCancellationHost<Session>, 'now'>,
): void {
  for (const entry of internal.pendingPermissions.values()) {
    emitCancelled(emit, host.now(), realIdForEmit, 'permission-cancelled', entry.payload.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolver({ behavior: 'deny', message: 'session ended', interrupt: true });
  }
  internal.pendingPermissions.clear();

  for (const entry of internal.pendingAskUserQuestions.values()) {
    emitCancelled(emit, host.now(), realIdForEmit, 'ask-question-cancelled', entry.payload.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolver({
      answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
    });
  }
  internal.pendingAskUserQuestions.clear();

  for (const entry of internal.pendingExitPlanModes.values()) {
    emitCancelled(emit, host.now(), realIdForEmit, 'exit-plan-cancelled', entry.payload.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolver({ decision: 'keep-planning', feedback: '会话已结束' });
  }
  internal.pendingExitPlanModes.clear();
}

export function runClaudeCloseSessionCleanupCore<
  Session extends ClaudePendingCancellationSession,
>(input: {
  sessions: Map<string, Session>;
  internal: Session;
  key: string;
  sessionId: string;
  emit: (event: AgentEvent) => void;
  markRecentlyDeleted?: boolean;
}, host: ClaudePendingCancellationHost<Session>): void {
  const {
    sessions,
    internal,
    key,
    sessionId,
    emit,
    markRecentlyDeleted = true,
  } = input;

  cancelClaudePendingAndEmitCore(internal, internal.applicationSid, emit, host);
  internal.pendingUserMessages.length = 0;
  internal.submittingUserMessage = null;
  internal.ignoredUserMessageIds?.clear();
  internal.acceptedEnqueueFingerprints?.clear();
  host.cleanupGatewaySandboxSettings(internal);

  if (sessions.get(key) === internal) sessions.delete(key);

  const identities = cleanupIdentities(sessionId, internal);
  for (const identity of identities) host.releaseSdkClaim(identity);
  if (markRecentlyDeleted) {
    for (const identity of identities) host.markRecentlyDeleted(identity);
  }

  const notify = internal.notify;
  internal.notify = null;
  try {
    notify?.();
  } catch {
    // A wakeup callback cannot change cleanup authority.
  }
}

function cleanupIdentities(
  sessionId: string,
  internal: Pick<ClaudePendingCancellationSession, 'applicationSid' | 'cliSessionId'>,
): string[] {
  const identities = [sessionId, internal.applicationSid];
  if (internal.cliSessionId) identities.push(internal.cliSessionId);
  return [...new Set(identities)];
}

function emitCancelled(
  emit: (event: AgentEvent) => void,
  timestamp: number,
  sessionId: string,
  type: 'permission-cancelled' | 'ask-question-cancelled' | 'exit-plan-cancelled',
  requestId: string,
): void {
  emit({
    sessionId,
    agentId: AGENT_ID,
    kind: 'waiting-for-user',
    payload: { type, requestId },
    ts: timestamp,
    source: 'sdk',
  });
}
