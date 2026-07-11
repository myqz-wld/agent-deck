import { describe, expect, it } from 'vitest';
import type { ClassifiedContinuationMessage } from '../message-classifier';
import { estimateRawUserTailTokens, selectRawUserTail } from '../raw-user-tail';

function message(id: number, text: string): ClassifiedContinuationMessage {
  return {
    eventId: id,
    effectiveRevision: id,
    ts: id,
    text,
    attachments: [],
    origin: 'user',
  };
}

describe('raw continuation user tail', () => {
  it('has no 200-message capacity ceiling', () => {
    const candidates = Array.from({ length: 300 }, (_, index) =>
      message(index + 1, `short-${index + 1}`),
    );
    const selected = selectRawUserTail(candidates, 20_000);
    expect(selected.messages).toHaveLength(300);
    expect(selected.messages[0].eventId).toBe(1);
    expect(selected.messages.at(-1)?.eventId).toBe(300);
  });

  it('keeps newest messages, truncates the boundary, and never skips to older rows', () => {
    const candidates = [
      message(1, 'old-short'),
      message(2, '界'.repeat(2_000)),
      message(3, 'new-short'),
    ];
    const selected = selectRawUserTail(candidates, 180);
    expect(selected.messages.map((entry) => entry.eventId)).toEqual([2, 3]);
    expect(selected.messages[0]).toMatchObject({ truncated: true });
    expect(selected.messages[0].text).toContain('estimated tokens omitted');
    expect(selected.messages[0].text).not.toContain('\uFFFD');
    expect(selected.truncatedBoundaryMessages).toBe(1);
    expect(selected.stoppedAtEventId).toBe(2);
    expect(estimateRawUserTailTokens(selected.messages)).toBeLessThanOrEqual(180);
  });

  it('stops at an oversized newest boundary instead of admitting older short rows', () => {
    const selected = selectRawUserTail(
      [message(1, 'old'), message(2, 'middle'), message(3, '🚀'.repeat(2_000))],
      120,
    );
    expect(selected.messages.map((entry) => entry.eventId)).toEqual([3]);
    expect(selected.messages[0].truncated).toBe(true);
  });

  it('orders equal-revision messages by id and returns chronological output', () => {
    const candidates = [message(3, 'third'), message(1, 'first'), message(2, 'second')];
    candidates.forEach((entry) => {
      entry.effectiveRevision = 5;
    });
    expect(selectRawUserTail(candidates, 500).messages.map((entry) => entry.eventId)).toEqual([
      1, 2, 3,
    ]);
  });
});
