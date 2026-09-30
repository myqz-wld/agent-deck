import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeCodexUsageReset } from './usage-reset';
import { createProviderUsageResetHandler } from '../provider-usage-reset';
import type { AgentAdapter } from '../types';
import type { CodexUsageClient } from './usage-probe-store';

const input = { provider: 'codex-cli' as const, accountId: 'test-account', idempotencyKey: '00000000-0000-4000-8000-000000000001' };
const usage = { accountId: 'test-account', rateLimitResetCredits: { availableCount: 4 } };

function client(response: unknown = { outcome: 'reset' }): CodexUsageClient & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn().mockResolvedValueOnce(usage).mockResolvedValueOnce(response), dispose: vi.fn() };
}

describe('Codex reset consumption', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'])('handles %s without guessing the new allowance', async (outcome) => {
    const rpc = client({ outcome });
    expect(await consumeCodexUsageReset(rpc, input)).toEqual({ outcome });
    expect(rpc.request.mock.calls).toEqual([
      ['account/rateLimits/read', { excludeResetCreditDetails: true }],
      ['account/rateLimitResetCredit/consume', { idempotencyKey: input.idempotencyKey }],
    ]);
  });

  it('rejects an account switch before any redemption', async () => {
    const rpc = client();
    rpc.request.mockReset().mockResolvedValue({ ...usage, accountId: 'another-account' });
    await expect(consumeCodexUsageReset(rpc, input)).rejects.toThrow('账户已变化');
    expect(rpc.request).toHaveBeenCalledOnce();
  });

  it('coalesces a repeated attempt and rejects overlapping new attempts', async () => {
    let finish!: (value: unknown) => void;
    const rpc = client();
    rpc.request.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = consumeCodexUsageReset(rpc, input);
    expect(consumeCodexUsageReset(rpc, input)).toBe(first);
    await expect(consumeCodexUsageReset(rpc, { ...input, idempotencyKey: '00000000-0000-4000-8000-000000000002' })).rejects.toThrow('正在使用');
    rpc.request.mockResolvedValueOnce({ outcome: 'reset' });
    finish(usage);
    await expect(first).resolves.toEqual({ outcome: 'reset' });
  });

  it('retains the caller key when retrying after a lost response', async () => {
    const rpc = client();
    rpc.request.mockReset().mockResolvedValueOnce(usage).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(usage).mockResolvedValueOnce({ outcome: 'alreadyRedeemed' });
    await expect(consumeCodexUsageReset(rpc, input)).rejects.toThrow();
    await expect(consumeCodexUsageReset(rpc, input)).resolves.toEqual({ outcome: 'alreadyRedeemed' });
    const attempts = rpc.request.mock.calls.filter(([method]) => method.endsWith('/consume'));
    expect(attempts.map(([, params]) => params)).toEqual([
      { idempotencyKey: input.idempotencyKey }, { idempotencyKey: input.idempotencyKey },
    ]);
  });

  it('serializes authority-wide requests and invalidates before and after consumption', async () => {
    let finish!: (value: unknown) => void;
    const consume = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const invalidate = vi.fn();
    const reset = createProviderUsageResetHandler(() => ({ consumeUsageReset: consume }) as unknown as AgentAdapter, invalidate);
    const first = reset(input);
    expect(reset(input)).toBe(first);
    await expect(reset({ ...input, idempotencyKey: '00000000-0000-4000-8000-000000000002' })).rejects.toThrow('正在使用');
    expect(invalidate).toHaveBeenCalledOnce();
    finish({ outcome: 'reset' });
    await first;
    expect(consume).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
