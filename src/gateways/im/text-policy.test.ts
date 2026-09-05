import { describe, expect, it } from 'vitest';
import { createPermissionPreviewDisplay } from '@contracts/index';
import { resolveGatewayLimits } from './gateway-config';
import { validateHistoryResult, validatePendingListResult, validateSendResult } from './core-output';
import { assertBoundedCoreValue } from './core-bounds';
import { redactJson } from './redaction';

const limits = resolveGatewayLimits(undefined);
const history = (content: unknown) => ({
  entries: [{ id: 'event-1', sessionId: 'session-1', sequence: 1, role: 'assistant', content, createdAt: 1 }],
  nextCursor: null, revision: 1,
});

describe('bounded human text and strict Core control data', () => {
  it('accepts multiline history, permission commands and redacted nested text', () => {
    const text = 'First\nSecond\r\n\tindented';
    expect(validateHistoryResult(history({ message: text }), 'session-1', limits).entries[0].content)
      .toEqual({ message: text });
    const display = createPermissionPreviewDisplay('Bash', { command: text });
    expect(validatePendingListResult({ requests: [{
      id: 'pending-1', sessionId: 'session-1', kind: 'permission', status: 'pending',
      createdAt: 1, expiresAt: null, display,
    }], revision: 1 }, 'session-1', limits).requests[0].display).toEqual(display);
    expect(redactJson({ message: text, apiKey: 'secret', answer: 'First\nBearer 0123456789abcdef' }))
      .toEqual({ message: text, apiKey: '[REDACTED]', answer: '[REDACTED]' });
  });

  it.each(['\u0000', '\u000b', '\u000c', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029'])('rejects forbidden text controls %j', (control) => {
    expect(() => validateHistoryResult(history(`First${control}Second`), 'session-1', limits))
      .toThrowError(expect.objectContaining({ code: 'invalid_core_response' }));
  });

  it.each(['\n', '\r', '\t'])('keeps identifiers, keys and session ownership strict for %j', (control) => {
    const value = history('valid\ntext');
    value.entries[0].id += control;
    expect(() => validateHistoryResult(value, 'session-1', limits)).toThrow();
    expect(() => validateSendResult({ messageId: `message${control}id`, sequence: 1, revision: 1 }, limits)).toThrow();
    expect(() => validateHistoryResult({ ...history('text'), nextCursor: `cursor${control}bad` }, 'session-1', limits)).toThrow();
    expect(() => validateHistoryResult(history({ [`key${control}`]: 'text' }), 'session-1', limits)).toThrow();
    expect(() => validateHistoryResult(history('valid\ntext'), 'another-session', limits)).toThrow();
  });

  it('retains UTF-8 byte, response, depth and node limits for multiline values', () => {
    expect(() => assertBoundedCoreValue('界\n'.repeat(3), { ...limits, maxCoreFieldBytes: 10 }, 'text')).toThrow();
    expect(() => assertBoundedCoreValue(['a\nb', 'c\nd'], { ...limits, maxCoreResponseBytes: 10 }, 'text')).toThrow();
    expect(() => assertBoundedCoreValue({ child: { child: 'a\nb' } }, { ...limits, maxCoreJsonDepth: 1 }, 'text')).toThrow();
    expect(() => assertBoundedCoreValue(['a\nb', 'c\nd'], { ...limits, maxCoreJsonEntries: 1 }, 'text')).toThrow();
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(() => assertBoundedCoreValue(cyclic, limits, 'text')).toThrow();
  });
});
