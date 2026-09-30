import { parseUsageProviderResetParams, parseUsageProviderResetResult } from '@contracts/usage-reset';
import type { ProviderUsageResetResult } from '@shared/types';
import type { AgentAdapter } from './types';

/** One active redemption per authority, shared by all its UI callers. */
export function createProviderUsageResetHandler(
  adapter: (provider: string) => AgentAdapter | undefined,
  invalidate: () => void,
): (value: unknown) => Promise<ProviderUsageResetResult> {
  let active: { accountId: string; key: string; promise: Promise<ProviderUsageResetResult> } | null = null;
  return (value) => {
    const request = parseUsageProviderResetParams(value);
    if (active) {
      if (active.accountId === request.accountId && active.key === request.idempotencyKey) return active.promise;
      return Promise.reject(new Error('正在使用重置，请稍候'));
    }
    const provider = adapter(request.provider);
    if (!provider?.consumeUsageReset) return Promise.reject(new Error('当前提供方暂不支持额度重置'));
    invalidate();
    const promise = Promise.resolve().then(() => provider.consumeUsageReset!(request))
      .then(parseUsageProviderResetResult)
      .finally(() => { invalidate(); if (active?.promise === promise) active = null; });
    active = { accountId: request.accountId, key: request.idempotencyKey, promise };
    return promise;
  };
}
