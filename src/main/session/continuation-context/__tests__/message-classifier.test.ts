import { describe, expect, it } from 'vitest';
import { classifyContinuationMessage } from '../message-classifier';

function candidate(payload: unknown, overrides: Partial<{ kind: string }> = {}) {
  return {
    eventId: 1,
    effectiveRevision: 1,
    ts: 1000,
    kind: overrides.kind ?? 'message',
    payloadJson: JSON.stringify(payload),
  };
}

describe('continuation message classifier', () => {
  it('keeps exact normal user text and attachment-only inputs', () => {
    expect(
      classifyContinuationMessage(candidate({ role: 'user', text: '  indented code\n' })).message,
    ).toMatchObject({ text: '  indented code\n', origin: 'user' });
    expect(
      classifyContinuationMessage(
        candidate({
          role: 'user',
          text: '',
          attachments: [{ kind: 'uploaded', path: '/tmp/a.png', mime: 'image/png' }],
        }),
      ).message,
    ).toMatchObject({
      text: '',
      attachments: [{ path: '/tmp/a.png', mimeType: 'image/png' }],
    });
  });

  it('keeps meaningful cross-session wire messages with provenance', () => {
    const text = '[from reviewer @ codex-cli][msg abc][sid source]\nReview result';
    expect(classifyContinuationMessage(candidate({ role: 'user', text })).message).toMatchObject({
      text,
      origin: 'cross-session',
    });
    expect(
      classifyContinuationMessage(
        candidate({ role: 'user', text: '[from reviewer @ codex-cli][msg abc][sid source]\n' }),
      ).message,
    ).toBeNull();
  });

  it('excludes assistant, tool, error, synthetic, empty, and malformed rows', () => {
    expect(classifyContinuationMessage(candidate({ role: 'assistant', text: 'answer' })).message)
      .toBeNull();
    expect(classifyContinuationMessage(candidate({ role: 'user', text: 'error', error: true })).message)
      .toBeNull();
    expect(classifyContinuationMessage(candidate({ role: 'user', text: 'status', synthetic: true })).message)
      .toBeNull();
    expect(classifyContinuationMessage(candidate({ role: 'user', text: 'x' }, { kind: 'tool-use-end' })).message)
      .toBeNull();
    expect(
      classifyContinuationMessage({ ...candidate({}), payloadJson: '{bad json' }).message,
    ).toBeNull();
  });

  it('excludes the current generated continuation context to prevent recursive growth', () => {
    expect(
      classifyContinuationMessage(
        candidate({
          role: 'user',
          text: '===== Agent Deck Continuation Context v2 =====\nleak',
        }),
      ),
    ).toEqual({ message: null, warning: 'context-wrapper-excluded' });
  });

  it('does not treat a retired continuation header as a current trusted wrapper', () => {
    expect(
      classifyContinuationMessage(
        candidate({
          role: 'user',
          text: '===== Agent Deck Continuation Context v1 =====\nuser text',
        }),
      ).message,
    ).toMatchObject({
      text: '===== Agent Deck Continuation Context v1 =====\nuser text',
      origin: 'user',
    });
  });

  it('keeps the persisted instruction of a new trusted continuation message', () => {
    expect(
      classifyContinuationMessage(
        candidate({ role: 'user', text: 'Continue P4.', messageOrigin: 'continuation' }),
      ).message,
    ).toMatchObject({ text: 'Continue P4.', origin: 'user' });
  });
});
