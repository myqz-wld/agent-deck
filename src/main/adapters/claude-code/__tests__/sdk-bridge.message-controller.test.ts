import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { MAX_PENDING_MESSAGES } from '../sdk-bridge/constants';
import {
  sendClaudeMessage,
  type ClaudeMessageControllerContext,
} from '../sdk-bridge/message-controller';
import type { InternalSession, PendingUserMessage } from '../sdk-bridge/types';

function sessionWithPending(count = 0): InternalSession {
  return {
    pendingUserMessages: Array.from(
      { length: count },
      () => vi.fn(async () => ({})) as unknown as PendingUserMessage,
    ),
    pendingPermissions: new Map(),
    pendingAskUserQuestions: new Map(),
    pendingExitPlanModes: new Map(),
    notify: vi.fn(),
  } as unknown as InternalSession;
}

function context(
  sessions: Map<string, InternalSession>,
): ClaudeMessageControllerContext & {
  emit: ReturnType<typeof vi.fn<(event: AgentEvent) => void>>;
  recoverAndSend: ReturnType<typeof vi.fn>;
  makeUserMessage: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn<(event: AgentEvent) => void>();
  const recoverAndSend = vi.fn(async () => 'recovered');
  const makeUserMessage = vi.fn(
    () => vi.fn(async () => ({})) as unknown as PendingUserMessage,
  );
  return { sessions, emit, recoverAndSend, makeUserMessage };
}

describe('sendClaudeMessage handoff diversion', () => {
  it('allows successor handoff tails to bypass ordinary queue backpressure', async () => {
    const sessionId = 'claude-successor-tail-overflow';
    const session = sessionWithPending(MAX_PENDING_MESSAGES);
    const ctx = context(new Map([[sessionId, session]]));

    await sendClaudeMessage(ctx, {
      sessionId,
      text: 'mandatory handoff tail',
      allowQueueOverflow: true,
    });

    expect(session.pendingUserMessages).toHaveLength(MAX_PENDING_MESSAGES + 1);
  });

  it('bypasses ordinary queue pressure, persists once, and replays without another emit', async () => {
    const sessionId = 'claude-handoff-rollback-overflow';
    const session = sessionWithPending(MAX_PENDING_MESSAGES);
    const ctx = context(new Map([[sessionId, session]]));
    const lease = handOffCutoverCoordinator.tryAcquire(sessionId)!;

    await sendClaudeMessage(ctx, { sessionId, text: 'late correction' });

    expect(session.pendingUserMessages).toHaveLength(MAX_PENDING_MESSAGES);
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.makeUserMessage).not.toHaveBeenCalled();

    lease.release();
    await vi.waitFor(() => {
      expect(session.pendingUserMessages).toHaveLength(MAX_PENDING_MESSAGES + 1);
    });
    expect(ctx.makeUserMessage).toHaveBeenCalledOnce();
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(session.notify).toHaveBeenCalledOnce();
  });

  it('does not replay on the source after ownership commits to a successor', async () => {
    const sessionId = 'claude-handoff-commit';
    const session = sessionWithPending();
    const ctx = context(new Map([[sessionId, session]]));
    const lease = handOffCutoverCoordinator.tryAcquire(sessionId)!;

    await sendClaudeMessage(ctx, { sessionId, text: 'belongs to successor' });
    expect(lease.commit('claude-successor')).toBe(true);
    lease.release();

    expect(session.pendingUserMessages).toHaveLength(0);
    expect(ctx.makeUserMessage).not.toHaveBeenCalled();
    expect(handOffCutoverCoordinator.successorFor(sessionId)).toBe('claude-successor');
  });

  it('recovers a missing source on rollback without persisting the user event twice', async () => {
    const sessionId = 'claude-handoff-missing-source';
    const ctx = context(new Map());
    const lease = handOffCutoverCoordinator.tryAcquire(sessionId)!;

    await sendClaudeMessage(ctx, { sessionId, text: 'persisted before recovery' });
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.recoverAndSend).not.toHaveBeenCalled();

    lease.release();
    await vi.waitFor(() => expect(ctx.recoverAndSend).toHaveBeenCalledOnce());
    expect(ctx.recoverAndSend).toHaveBeenCalledWith(
      sessionId,
      'persisted before recovery',
      undefined,
      expect.objectContaining({
        userEventAlreadyPersisted: true,
        sendAfterRecovery: expect.any(Function),
      }),
    );
    expect(ctx.emit).toHaveBeenCalledTimes(1);
  });
});
