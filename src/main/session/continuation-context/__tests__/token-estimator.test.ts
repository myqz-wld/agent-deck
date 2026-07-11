import { describe, expect, it } from 'vitest';
import {
  estimateContinuationJsonTokens,
  estimateContinuationTokens,
  truncateContinuationTextMiddle,
  utf8ByteLength,
} from '../token-estimator';

describe('continuation token estimator', () => {
  it.each([
    ['ASCII prose', 'abcd'],
    ['code', 'const answer = foo?.bar ?? 42;'],
    ['CJK', '会话续接上下文'],
    ['emoji ZWJ', '👩‍💻🚀'],
    ['combining marks', 'e\u0301 cafe\u0301'],
    ['long path', '/Users/example/repository/src/main/session/continuation-context/service.ts'],
    ['log', '[2026-07-10T12:00:00Z] ERROR request_id=abc duration_ms=1249'],
  ])('%s uses the calibrated UTF-8 estimate', (_label, text) => {
    expect(estimateContinuationTokens(text)).toBe(
      Math.ceil((utf8ByteLength(text) / 4) * 1.15),
    );
  });

  it('charges structural overhead and JSON escaping explicitly', () => {
    const text = 'line 1\n"quoted"';
    expect(estimateContinuationTokens(text, { structuralOverhead: 7 })).toBe(
      estimateContinuationTokens(text) + 7,
    );
    expect(estimateContinuationJsonTokens({ text })).toBeGreaterThan(
      estimateContinuationTokens(text),
    );
  });

  it('middle-truncates on UTF-8 boundaries with an explicit marker', () => {
    const source = `${'前缀👩‍💻'.repeat(100)}${'suffix🚀'.repeat(100)}`;
    const result = truncateContinuationTextMiddle(source, 80);
    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(80);
    expect(result.text).toContain('estimated tokens omitted');
    expect(result.text).not.toContain('\uFFFD');
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
    expect(result.omittedBytes).toBeGreaterThan(0);
  });

  it('returns the original text when it already fits', () => {
    expect(truncateContinuationTextMiddle('small', 10)).toMatchObject({
      text: 'small',
      truncated: false,
      omittedBytes: 0,
    });
  });
});
