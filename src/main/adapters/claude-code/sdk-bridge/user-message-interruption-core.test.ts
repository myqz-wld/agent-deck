import { describe, expect, it } from 'vitest';
import { makeInternalSession } from './types';
import { finishClaudeUserMessageInterruptionCore } from './user-message-interruption-core';

const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
const interruptedResult = {
  subtype: 'error_during_execution',
  is_error: true,
  user_message_uuid: 'original',
  errors: [diagnostic],
};

function session(ids = ['correction']) {
  const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
  internal.midTurnUserMessageIds = new Set(ids);
  return internal;
}

describe('Claude streamed input interruption', () => {
  it.each([undefined, 'aborted_streaming', 'aborted_tools'])(
    'recognizes the known interruption with terminal reason %s', (terminal_reason) => {
      const internal = session();
      expect(finishClaudeUserMessageInterruptionCore(internal, {
        ...interruptedResult, terminal_reason,
        errors: [terminal_reason === 'aborted_tools'
          ? diagnostic.replace('null', 'tool_use') : diagnostic],
      })).toBe(true);
      expect([...internal.midTurnUserMessageIds!]).toEqual(['correction']);
    },
  );

  it.each([
    { errors: ['network failure'] },
    { errors: [diagnostic, 'authentication failed'] },
    { errors: [] },
    { errors: [null] },
    { errors: [diagnostic + ' API failure'] },
    { errors: [diagnostic.replace('result_type=user', 'result_type=assistant')] },
    { terminal_reason: 'api_error' },
    { terminal_reason: 'prompt_too_long' },
    { subtype: 'error_max_turns' },
    { is_error: false },
  ])('preserves a real or unrecognized failure: %j', (override) => {
    expect(finishClaudeUserMessageInterruptionCore(session(), {
      ...interruptedResult, ...override,
    })).toBe(false);
  });

  it('requires an input that was actually streamed into an active turn', () => {
    expect(finishClaudeUserMessageInterruptionCore(session([]), interruptedResult)).toBe(false);
  });

  it('never masks a failure of the correction itself', () => {
    const internal = session();
    expect(finishClaudeUserMessageInterruptionCore(internal, interruptedResult)).toBe(true);
    expect(finishClaudeUserMessageInterruptionCore(internal, {
      ...interruptedResult, user_message_uuid: 'correction',
    })).toBe(false);
    expect(internal.midTurnUserMessageIds?.size).toBe(0);
  });

  it.each([true, false])('settles coalesced corrections (UUID list: %s)', (withList) => {
    const internal = session(['first', 'second', 'third']);
    expect(finishClaudeUserMessageInterruptionCore(internal, {
      subtype: 'success', user_message_uuid: 'second',
      ...(withList ? { user_message_uuids: ['original', 'first', 'second'] } : {}),
    })).toBe(false);
    expect([...internal.midTurnUserMessageIds!]).toEqual(['third']);
    expect(finishClaudeUserMessageInterruptionCore(internal, {
      ...interruptedResult, user_message_uuid: 'third',
    })).toBe(false);
  });

  it.each(['success', 'error_during_execution'])(
    'expires legacy uncorrelated evidence on a %s result', (subtype) => {
      const internal = session();
      expect(finishClaudeUserMessageInterruptionCore(internal, {
        ...interruptedResult, subtype, user_message_uuid: undefined,
      })).toBe(subtype === 'error_during_execution');
      expect(internal.midTurnUserMessageIds?.size).toBe(0);
      expect(finishClaudeUserMessageInterruptionCore(internal, interruptedResult)).toBe(false);
    },
  );
});
