import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { MAX_PENDING_MESSAGES } from '../sdk-bridge/constants';
import {
  sendClaudeMessage,
  type ClaudeMessageControllerContext,
} from '../sdk-bridge/message-controller';
import {
  listClaudePendingOutgoingMessages,
  removeClaudePendingOutgoingMessage,
} from '../sdk-bridge/pending-outgoing';
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
  it('lists and atomically removes a deferred user message before SDK consumption', async () => {
    const sessionId = 'claude-visible-pending';
    const session = sessionWithPending();
    session.applicationSid = sessionId;
    session.cliSessionId = sessionId;
    const sessions = new Map([[sessionId, session]]);
    const ctx = context(sessions);
    const attachment = {
      kind: 'uploaded' as const,
      path: '/tmp/pending.png',
      mime: 'image/png',
      bytes: 10,
    };

    await sendClaudeMessage(ctx, {
      sessionId,
      text: 'wait for Claude',
      attachments: [attachment],
      enqueueOptions: {
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: 'pending-1',
      },
    });

    expect(ctx.emit).not.toHaveBeenCalled();
    expect(listClaudePendingOutgoingMessages(sessions, sessionId)).toEqual([{
      id: 'pending-1',
      text: 'wait for Claude',
      attachments: [attachment],
    }]);
    expect(removeClaudePendingOutgoingMessage(sessions, sessionId, 'pending-1')).toEqual({
      id: 'pending-1',
      text: 'wait for Claude',
      attachments: [attachment],
    });
    expect(session.pendingUserMessages).toEqual([]);
    expect(removeClaudePendingOutgoingMessage(sessions, sessionId, 'pending-1')).toBeNull();
  });

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

  it('preserves a deferred correlation marker through missing-session recovery', async () => {
    const sourceId = 'claude-missing-correlated-turn';
    const recoveredId = 'claude-recovered-correlated-turn';
    const sessions = new Map<string, InternalSession>();
    const ctx = context(sessions);
    const recovered = sessionWithPending();
    ctx.recoverAndSend.mockImplementationOnce(async (
      _sid,
      _text,
      _attachments,
      options?: { sendAfterRecovery?: (sessionId: string) => Promise<void> },
    ) => {
      sessions.set(recoveredId, recovered);
      await options?.sendAfterRecovery?.(recoveredId);
      return recoveredId;
    });

    await sendClaudeMessage(ctx, {
      sessionId: sourceId,
      text: 'correlated recovery prompt',
      enqueueOptions: {
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: 'recovered-turn-1',
      },
    });

    expect(ctx.recoverAndSend).toHaveBeenCalledWith(
      sourceId,
      'correlated recovery prompt',
      undefined,
      expect.objectContaining({
        initialEnqueueOptions: expect.objectContaining({
          deferUserEventUntilTurnStart: true,
          turnCorrelationId: 'recovered-turn-1',
        }),
        sendAfterRecovery: expect.any(Function),
      }),
    );
    expect(recovered.pendingUserMessages[0]?.deferredUserEvent).toEqual({
      text: 'correlated recovery prompt',
      turnCorrelationId: 'recovered-turn-1',
    });
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('acknowledges an accepted keyed turn when its event throws and deduplicates retry', async () => {
    const sessionId = 'claude-idempotent-late-decision';
    const session = sessionWithPending();
    const ctx = context(new Map([[sessionId, session]]));
    ctx.emit.mockImplementationOnce(() => {
      throw new Error('event sink unavailable');
    });
    const input = {
      sessionId,
      text: 'approve plan',
      enqueueOptions: { idempotencyKey: 'plan-late-decision:plan-1' },
    };

    await expect(sendClaudeMessage(ctx, input)).resolves.toBeUndefined();
    await expect(sendClaudeMessage(ctx, input)).resolves.toBeUndefined();

    expect(session.pendingUserMessages).toHaveLength(1);
    expect(session.acceptedEnqueueFingerprints?.size).toBe(1);
    await expect(sendClaudeMessage(ctx, { ...input, text: 'revise plan' }))
      .rejects.toThrow('different payload');
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
