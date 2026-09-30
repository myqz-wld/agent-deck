import {
  parseUsageProviderResetParams,
  parseUsageProviderResetResult,
} from '@contracts/usage-reset';
import type { ProviderUsageResetRequest, ProviderUsageResetResult } from '@shared/types';
import type { CodexAccountRateLimitsResponseLike } from '../provider-usage';
import type { CodexUsageClient } from './usage-probe-store';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';

const inFlight = new WeakMap<CodexUsageClient, {
  accountId: string;
  key: string;
  promise: Promise<ProviderUsageResetResult>;
}>();

/** No thread or turn is created. Retries of an ambiguous attempt retain the same key. */
export function consumeCodexUsageReset(
  client: CodexUsageClient,
  input: ProviderUsageResetRequest,
  timeoutMs = 20_000,
): Promise<ProviderUsageResetResult> {
  const request = parseUsageProviderResetParams(input);
  const active = inFlight.get(client);
  if (active) {
    if (active.key === request.idempotencyKey && active.accountId === request.accountId) return active.promise;
    return Promise.reject(new Error('正在使用重置，请稍候'));
  }
  const promise = perform(client, request, timeoutMs).finally(() => {
    if (inFlight.get(client)?.promise === promise) inFlight.delete(client);
  });
  inFlight.set(client, { accountId: request.accountId, key: request.idempotencyKey, promise });
  return promise;
}

async function perform(
  client: CodexUsageClient,
  request: ProviderUsageResetRequest,
  timeoutMs: number,
): Promise<ProviderUsageResetResult> {
  const before = await raceWithTimeout({
    work: client.request<CodexAccountRateLimitsResponseLike>(
      'account/rateLimits/read', { excludeResetCreditDetails: true },
    ),
    timeoutMs,
    errorMessage: '确认账户信息超时，请刷新额度后重试',
  });
  if (!before.accountId || before.accountId !== request.accountId) {
    throw new Error('Codex 账户已变化，请刷新额度后重新确认');
  }
  return parseUsageProviderResetResult(await raceWithTimeout({
    work: client.request('account/rateLimitResetCredit/consume', {
      idempotencyKey: request.idempotencyKey,
    }),
    timeoutMs,
    errorMessage: '尚未确认重置结果，请重试本次操作',
  }));
}
