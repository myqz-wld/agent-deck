import { describe, expect, it, vi } from 'vitest';

import {
  confirmClaudeUserMessageAcceptanceCore,
  discardClaudeSubmittingUserMessageCore,
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

  it('ignores non-user, malformed, mismatched, and explicitly fenced echoes', () => {
    const session = internal();
    const emit = vi.fn();
    submitted(session);

    for (const message of [
      { type: 'assistant', uuid: 'provider-1' },
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
});
