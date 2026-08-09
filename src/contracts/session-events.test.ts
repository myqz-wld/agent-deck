import { describe, expect, it } from 'vitest';

import { SessionConsoleContractError } from './session-console-common';
import {
  parseSessionEventListParams,
  parseSessionEventListResult,
  SESSION_EVENT_MAX_PAYLOAD_BYTES,
} from './session-events';

describe('session event contracts', () => {
  it('accepts an exact bounded event page', () => {
    expect(parseSessionEventListParams({ sessionId: 'session-a', limit: 20 })).toEqual({
      sessionId: 'session-a',
      limit: 20,
    });
    expect(parseSessionEventListResult({
      events: [{
        id: 3,
        sessionId: 'session-a',
        agentId: 'codex-cli',
        kind: 'message',
        payload: { role: 'assistant', text: '完成' },
        ts: 4,
      }],
      revision: 9,
      truncated: false,
    }, 'session-a', 20)).toMatchObject({ events: [{ id: 3 }], revision: 9 });
  });

  it('rejects identity drift, extra fields, deep JSON, and oversized payloads', () => {
    const base = {
      id: 3,
      sessionId: 'session-a',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {},
      ts: 4,
    };
    const parse = (event: unknown) => parseSessionEventListResult({
      events: [event], revision: 9, truncated: false,
    }, 'session-a', 20);
    expect(() => parse({ ...base, sessionId: 'session-b' })).toThrow(SessionConsoleContractError);
    expect(() => parse({ ...base, cwd: '/private' })).toThrow(SessionConsoleContractError);
    let deep: unknown = 'leaf';
    for (let index = 0; index < 34; index += 1) deep = [deep];
    expect(() => parse({ ...base, payload: deep })).toThrow(SessionConsoleContractError);
    expect(() => parse({
      ...base,
      payload: { text: 'x'.repeat(SESSION_EVENT_MAX_PAYLOAD_BYTES + 1) },
    })).toThrow(SessionConsoleContractError);
  });
});
