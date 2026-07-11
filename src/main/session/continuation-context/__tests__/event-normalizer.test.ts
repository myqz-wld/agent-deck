import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import {
  MAX_NORMALIZED_EVENT_UTF8_BYTES,
  normalizeContinuationEvent,
} from '../event-normalizer';

function row(kind: string, payloadJson: string): RawEventRevisionRow {
  return {
    id: 1,
    sessionId: 'source',
    effectiveRevision: 2,
    kind,
    payloadJson,
    ts: 1000,
    toolUseId: null,
  };
}

describe('continuation event normalizer', () => {
  it('excludes internal thinking and raw token telemetry', () => {
    expect(normalizeContinuationEvent(row('thinking', '{}'))).toBeNull();
    expect(normalizeContinuationEvent(row('token-usage', '{}'))).toBeNull();
  });

  it('preserves normal structured payloads with source provenance', () => {
    const payloadJson = JSON.stringify({ role: 'assistant', text: 'done' });
    expect(normalizeContinuationEvent(row('message', payloadJson))).toEqual({
      eventId: 1,
      effectiveRevision: 2,
      kind: 'message',
      ts: 1000,
      payload: { role: 'assistant', text: 'done' },
      sourceBytes: Buffer.byteLength(payloadJson),
      sourceHash: createHash('sha256').update(payloadJson).digest('hex'),
      truncated: false,
    });
  });

  it('keeps malformed evidence explicit instead of creating a revision hole', () => {
    expect(normalizeContinuationEvent(row('tool-use-end', '{malformed'))).toMatchObject({
      payload: { malformedPayloadJson: '{malformed' },
      truncated: false,
    });
  });

  it('bounds one huge event on UTF-8 boundaries and always preserves hash/length markers', () => {
    const payloadJson = JSON.stringify({ output: '界👩‍💻'.repeat(20_000) });
    const normalized = normalizeContinuationEvent(row('tool-use-end', payloadJson));
    expect(normalized).toMatchObject({
      truncated: true,
      sourceBytes: Buffer.byteLength(payloadJson),
      sourceHash: createHash('sha256').update(payloadJson).digest('hex'),
    });
    expect(JSON.stringify(normalized?.payload).length).toBeLessThan(
      MAX_NORMALIZED_EVENT_UTF8_BYTES,
    );
    expect(JSON.stringify(normalized?.payload)).not.toContain('\uFFFD');
  });
});
