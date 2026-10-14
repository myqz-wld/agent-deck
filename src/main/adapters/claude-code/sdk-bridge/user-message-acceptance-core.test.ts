import { describe, expect, it, vi } from 'vitest';

import {
  confirmClaudeUserMessageAcceptanceCore,
  discardClaudeSubmittingUserMessageCore,
  finishClaudeUserMessageTurnCore,
  rememberIgnoredClaudeUserMessageIdCore,
  type ClaudeUserMessageAcceptanceHost,
} from './user-message-acceptance-core';
import {
  makeInternalSession,
  type InternalSession,
  type PendingUserMessage,
} from './types';

function internal(): InternalSession {
  return makeInternalSession({
    cwd: '/workspace',
    permissionMode: 'default',
    applicationSid: 'application-a',
  });
}

function submitted(internalSession: InternalSession): void {
  const pending = vi.fn(async () => ({})) as unknown as PendingUserMessage;
  pending.deferredUserEvent = {
    text: 'accepted input',
    turnCorrelationId: 'turn-1',
    attachments: [
      { kind: 'uploaded', path: '/input.png', mime: 'image/png', bytes: 1 },
    ],
  };
  internalSession.submittingUserMessage = {
    pending,
    providerMessageId: 'provider-1',
    status: 'submitting',
  };
}

const host: ClaudeUserMessageAcceptanceHost = {
  agentId: 'claude-core',
  now: () => 5150,
};

describe('Claude user message acceptance Core', () => {
  it('emits a deferred user event only for the matching provider echo', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);

    confirmClaudeUserMessageAcceptanceCore(
      emit,
      'application-a',
      { type: 'user', uuid: 'provider-1' },
      session,
      host,
    );

    expect(session.submittingUserMessage).toBeNull();
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'application-a',
      agentId: 'claude-core',
      kind: 'message',
      payload: {
        text: 'accepted input',
        role: 'user',
        turnCorrelationId: 'turn-1',
        attachments: [
          { kind: 'uploaded', path: '/input.png', mime: 'image/png', bytes: 1 },
        ],
      },
      ts: 5150,
      source: 'sdk',
    });
  });

  it('accepts a UUID-rewritten turn when its first top-level assistant frame arrives', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);

    confirmClaudeUserMessageAcceptanceCore(
      emit,
      'application-a',
      { type: 'user', uuid: 'provider-rewritten' },
      session,
      host,
    );
    expect(session.submittingUserMessage).not.toBeNull();

    confirmClaudeUserMessageAcceptanceCore(
      emit,
      'application-a',
      { type: 'assistant', uuid: 'assistant-1', parent_tool_use_id: null },
      session,
      host,
    );

    expect(session.submittingUserMessage).toBeNull();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'application-a',
      kind: 'message',
      payload: expect.objectContaining({
        text: 'accepted input',
        role: 'user',
        turnCorrelationId: 'turn-1',
      }),
    }));
  });

  it('does not treat a subagent assistant frame as main-turn acceptance', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);

    confirmClaudeUserMessageAcceptanceCore(
      emit,
      'application-a',
      {
        type: 'assistant',
        uuid: 'subagent-assistant-1',
        parent_tool_use_id: 'parent-tool-1',
      },
      session,
      host,
    );

    expect(session.submittingUserMessage).not.toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('accepts an idle input at response start before a long thinking block completes', () => {
    const session = internal();
    const emit = vi.fn();
    const notify = vi.fn();
    submitted(session);
    session.notify = notify;

    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { role: 'assistant' } },
    }, session, host);

    expect(session.submittingUserMessage).toBeNull();
    expect(emit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'assistant',
    }, session, host);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('does not acknowledge input from ambiguous streaming activity', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);
    const responseStart = {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant' } },
    };
    for (const message of [
      { type: 'stream_event' },
      { type: 'stream_event', event: { type: 'ping' } },
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_start', message: { role: 'user' } } },
      { ...responseStart, parent_tool_use_id: 'subagent-tool' },
      { ...responseStart, user_message_uuid: 'previous-input' },
      { ...responseStart, user_message_uuids: ['previous-input'] },
    ]) {
      confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', message, session, host);
    }
    for (const precedingTurn of ['active', 'finished'] as const) {
      session.submittingUserMessage!.precedingTurn = precedingTurn;
      confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', responseStart, session, host);
    }
    expect(emit).not.toHaveBeenCalled();
    expect(session.submittingUserMessage).not.toBeNull();
  });

  it('ignores non-user, malformed, mismatched, and explicitly fenced echoes', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);

    for (const message of [
      { type: 'system', uuid: 'provider-1' },
      { type: 'user', uuid: 1 },
      { type: 'user', uuid: 'provider-other' },
    ]) {
      confirmClaudeUserMessageAcceptanceCore(
        emit,
        'application-a',
        message,
        session,
        host,
      );
    }
    expect(session.submittingUserMessage).not.toBeNull();

    rememberIgnoredClaudeUserMessageIdCore(session, 'provider-1');
    confirmClaudeUserMessageAcceptanceCore(
      emit,
      'application-a',
      { type: 'user', uuid: 'provider-1' },
      session,
      host,
    );
    expect(emit).not.toHaveBeenCalled();
    expect(session.submittingUserMessage).not.toBeNull();
    expect(session.ignoredUserMessageIds?.has('provider-1')).toBe(false);
  });

  it('discards a submitted message while retaining a bounded late-echo fence', () => {
    const session = internal();
    submitted(session);

    discardClaudeSubmittingUserMessageCore(session);

    expect(session.submittingUserMessage).toBeNull();
    expect(session.ignoredUserMessageIds).toEqual(new Set(['provider-1']));

    for (let index = 0; index < 33; index += 1) {
      rememberIgnoredClaudeUserMessageIdCore(session, `provider-${index + 2}`);
    }
    expect(session.ignoredUserMessageIds).toHaveLength(32);
    expect(session.ignoredUserMessageIds?.has('provider-1')).toBe(false);
    expect(session.ignoredUserMessageIds?.has('provider-34')).toBe(true);
  });

  it('does not acknowledge mid-turn input from earlier-turn output or subagent echoes', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);
    session.submittingUserMessage!.precedingTurn = 'active';

    for (const message of [
      { type: 'assistant', parent_tool_use_id: null },
      { type: 'assistant', user_message_uuid: 'earlier-input' },
      { type: 'result', user_message_uuid: 'earlier-input' },
      { type: 'stream_event', user_message_uuids: ['earlier-input'] },
      { type: 'user', uuid: 'provider-1', parent_tool_use_id: 'subagent-tool' },
      { type: 'assistant', user_message_uuid: 'provider-1', parent_tool_use_id: 'subagent-tool' },
    ]) {
      confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', message, session, host);
    }
    expect(emit).not.toHaveBeenCalled();
    expect(session.submittingUserMessage).not.toBeNull();
  });

  it.each(['user', 'assistant', 'stream_event', 'result'])(
    'acknowledges mid-turn input exactly once from a correlated %s frame', (type) => {
      const session = internal();
      const emit = vi.fn();
      const notify = vi.fn();
      submitted(session);
      session.submittingUserMessage!.precedingTurn = 'active';
      session.notify = notify;
      const message = type === 'user'
        ? { type, uuid: 'provider-1', parent_tool_use_id: null }
        : { type, user_message_uuid: 'provider-1', parent_tool_use_id: null };

      confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', message, session, host);
      confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', message, session, host);

      expect(emit).toHaveBeenCalledOnce();
      expect(session.submittingUserMessage).toBeNull();
      expect(notify).toHaveBeenCalledOnce();
    },
  );

  it('accepts input folded into a turn when only the consumed UUID list identifies it', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);
    session.submittingUserMessage!.precedingTurn = 'active';
    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'result', user_message_uuid: 'earlier-input',
      user_message_uuids: ['earlier-input', 'provider-1'],
    }, session, host);
    expect(session.submittingUserMessage).toBeNull();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('retains a mid-turn submission when the preceding turn finishes', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);
    const submitting = session.submittingUserMessage!;
    submitting.precedingTurn = 'active';

    finishClaudeUserMessageTurnCore(session, emit, 'application-a', host);

    expect(session.submittingUserMessage).toBe(submitting);
    expect(submitting.precedingTurn).toBe('finished');
    expect(session.ignoredUserMessageIds?.size ?? 0).toBe(0);
    // Delayed output (including another result) is still not proof of this input's acceptance.
    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', { type: 'assistant' }, session, host);
    finishClaudeUserMessageTurnCore(session, emit, 'application-a', host);
    expect(emit).not.toHaveBeenCalled();
    expect(session.submittingUserMessage).toBe(submitting);
    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'user', uuid: 'provider-1',
    }, session, host);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('does not use the idle-turn fallback for explicitly mismatched correlation', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);
    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'assistant', user_message_uuid: 'other-input',
    }, session, host);
    expect(emit).not.toHaveBeenCalled();
    expect(session.submittingUserMessage).not.toBeNull();
  });

  it('reports app queue and SDK acceptance delays separately without prompt content', () => {
    const session = internal();
    const emit = vi.fn();
    const observeSlowAcceptance = vi.fn();
    submitted(session);
    session.submittingUserMessage!.pending.enqueuedAt = 100;
    session.submittingUserMessage!.submittedAt = 150;
    session.submittingUserMessage!.precedingTurn = 'active';

    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'user', uuid: 'provider-1',
    }, session, { ...host, observeSlowAcceptance });

    expect(observeSlowAcceptance).toHaveBeenCalledOnce();
    expect(observeSlowAcceptance).toHaveBeenCalledWith({
      sessionId: 'application-a', messageId: 'provider-1',
      appQueueMs: 50, sdkAcceptanceMs: 5000, acceptanceFrame: 'user', midTurn: true,
    });
    expect(emit).toHaveBeenCalledOnce();
  });

  it('does not produce a slow-input diagnostic for fast or unrelated responses', () => {
    const session = internal();
    const observeSlowAcceptance = vi.fn();
    submitted(session);
    session.submittingUserMessage!.pending.enqueuedAt = 5100;
    session.submittingUserMessage!.submittedAt = 5120;
    for (const uuid of ['unrelated-message', 'provider-1']) {
      confirmClaudeUserMessageAcceptanceCore(vi.fn(), 'application-a', {
        type: 'user', uuid,
      }, session, { ...host, observeSlowAcceptance });
    }
    expect(observeSlowAcceptance).not.toHaveBeenCalled();
  });

  it('still acknowledges and wakes the next input when slow-input logging fails', () => {
    const session = internal();
    const emit = vi.fn();
    const notify = vi.fn();
    submitted(session);
    session.notify = notify;
    session.submittingUserMessage!.pending.enqueuedAt = 100;
    session.submittingUserMessage!.submittedAt = 3100;
    const observeSlowAcceptance = vi.fn(() => { throw new Error('diagnostics unavailable'); });

    confirmClaudeUserMessageAcceptanceCore(emit, 'application-a', {
      type: 'user', uuid: 'provider-1',
    }, session, { ...host, now: () => 3150, observeSlowAcceptance });

    expect(observeSlowAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      appQueueMs: 3000, sdkAcceptanceMs: 50,
    }));
    expect(session.submittingUserMessage).toBeNull();
    expect(emit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });
});
