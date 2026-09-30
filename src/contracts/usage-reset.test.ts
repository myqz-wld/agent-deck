import { describe, expect, it } from 'vitest';
import { parseUsageProviderResetParams, parseUsageProviderResetResult, parseUsageResetCredits } from './usage-reset';

const request = { provider: 'codex-cli', accountId: 'test-account', idempotencyKey: '00000000-0000-4000-8000-000000000001' };

describe('provider reset contracts', () => {
  it('keeps unknown, zero and positive counts distinct', () => {
    for (const count of [null, 0, 4]) {
      expect(parseUsageResetCredits({ availableCount: count, accountId: null }).availableCount).toBe(count);
    }
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
      expect(() => parseUsageResetCredits({ availableCount: count, accountId: null })).toThrow();
    }
  });

  it('requires an account and a stable UUID for the supported provider only', () => {
    expect(parseUsageProviderResetParams(request)).toEqual(request);
    for (const patch of [{ provider: 'grok-build' }, { accountId: '' }, { accountId: 'a\nb' }, { idempotencyKey: '' }, { extra: true }]) {
      expect(() => parseUsageProviderResetParams({ ...request, ...patch })).toThrow();
    }
  });

  it('accepts only the documented redemption outcomes', () => {
    for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
      expect(parseUsageProviderResetResult({ outcome })).toEqual({ outcome });
    }
    expect(() => parseUsageProviderResetResult({ outcome: 'ok' })).toThrow();
  });
});
