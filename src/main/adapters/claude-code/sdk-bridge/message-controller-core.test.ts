import { describe, expect, it, vi } from 'vitest';
import {
  sendClaudeMessageCore,
  type ClaudeMessageControllerContext,
  type ClaudeMessageControllerHost,
} from './message-controller-core';
import type { InternalSession, PendingUserMessage } from './types';

describe('Claude message controller Core', () => {
  it('keeps an accepted keyed enqueue authoritative when event emission fails', async () => {
    const session = {
      pendingUserMessages: [],
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      notify: vi.fn(),
    } as unknown as InternalSession;
    const context: ClaudeMessageControllerContext = {
      sessions: new Map([['session', session]]),
      emit: vi.fn(() => { throw new Error('event failed'); }),
      recoverAndSend: vi.fn(),
      makeUserMessage: vi.fn(
        () => vi.fn(async () => ({})) as unknown as PendingUserMessage,
      ),
    };
    const host: ClaudeMessageControllerHost = {
      guardSourceIngress: vi.fn(() => false),
      acceptedEnqueueEventFailed: vi.fn(),
      now: vi.fn(() => 42),
    };
    const input = {
      sessionId: 'session',
      text: 'accepted',
      enqueueOptions: { idempotencyKey: 'intent-1' },
    };

    await sendClaudeMessageCore(context, input, host);
    await sendClaudeMessageCore(context, input, host);

    expect(session.pendingUserMessages).toHaveLength(1);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ ts: 42 }));
    expect(host.acceptedEnqueueEventFailed).toHaveBeenCalledOnce();
    expect(session.notify).toHaveBeenCalledTimes(2);
  });
});
