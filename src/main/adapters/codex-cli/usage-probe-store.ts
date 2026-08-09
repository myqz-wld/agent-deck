import type { ProviderUsageSnapshot } from '@shared/types';
import {
  buildCodexUsageSnapshot,
  errorUsageSnapshot,
  unavailableUsageSnapshot,
  type CodexAccountRateLimitsResponseLike,
} from '../provider-usage';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';

const CODEX_USAGE_UNAVAILABLE_MESSAGE =
  'Codex 额度信息暂不可读，请确认 Codex 已登录且网络可用';

export interface CodexUsageClient {
  request<T>(method: string, params: unknown): Promise<T>;
  dispose(): void;
}

export interface CodexUsageProbeStore {
  read(input: {
    clientKey: string;
    makeClient: () => CodexUsageClient;
    cacheClient: boolean;
    timeoutMs: number;
    idleDisposeMs: number;
  }): Promise<ProviderUsageSnapshot>;
  invalidate(): void;
}

export function createCodexUsageProbeStore(): CodexUsageProbeStore {
  let cachedClient: CodexUsageClient | null = null;
  let cachedClientKey: string | null = null;
  let cachedClientIdleTimer: ReturnType<typeof setTimeout> | null = null;

  async function read(input: {
    clientKey: string;
    makeClient: () => CodexUsageClient;
    cacheClient: boolean;
    timeoutMs: number;
    idleDisposeMs: number;
  }): Promise<ProviderUsageSnapshot> {
    const { client, disposeAfterRead } = getClient(input);
    try {
      const response = await raceWithTimeout({
        work: client.request<CodexAccountRateLimitsResponseLike>(
          'account/rateLimits/read',
          undefined,
        ),
        timeoutMs: input.timeoutMs,
        errorMessage: '__codex_usage_timeout__',
        onTimeout: () => {
          if (disposeAfterRead) client.dispose();
          else invalidate();
        },
      });
      return buildCodexUsageSnapshot(response);
    } catch (error) {
      return isExpectedCodexUsageUnavailable(error)
        ? codexUsageUnavailableSnapshot()
        : errorUsageSnapshot('codex-cli', error);
    } finally {
      if (disposeAfterRead) {
        client.dispose();
      } else if (cachedClient === client) {
        scheduleCachedClientDisposal(input.idleDisposeMs);
      }
    }
  }

  function getClient(input: {
    clientKey: string;
    makeClient: () => CodexUsageClient;
    cacheClient: boolean;
  }): { client: CodexUsageClient; disposeAfterRead: boolean } {
    if (!input.cacheClient) {
      return { client: input.makeClient(), disposeAfterRead: true };
    }
    if (!cachedClient || cachedClientKey !== input.clientKey) {
      invalidate();
      cachedClient = input.makeClient();
      cachedClientKey = input.clientKey;
    }
    clearCachedClientIdleTimer();
    return { client: cachedClient, disposeAfterRead: false };
  }

  function scheduleCachedClientDisposal(ms: number): void {
    clearCachedClientIdleTimer();
    cachedClientIdleTimer = setTimeout(invalidate, Math.max(0, ms));
    cachedClientIdleTimer.unref?.();
  }

  function clearCachedClientIdleTimer(): void {
    if (!cachedClientIdleTimer) return;
    clearTimeout(cachedClientIdleTimer);
    cachedClientIdleTimer = null;
  }

  function invalidate(): void {
    clearCachedClientIdleTimer();
    cachedClient?.dispose();
    cachedClient = null;
    cachedClientKey = null;
  }

  return { read, invalidate };
}

export function codexUsageUnavailableSnapshot(): ProviderUsageSnapshot {
  return unavailableUsageSnapshot(
    'codex-cli',
    CODEX_USAGE_UNAVAILABLE_MESSAGE,
  );
}

export function isExpectedCodexUsageUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /failed to fetch codex rate limits/i.test(message) ||
    /backend-api\/wham\/usage/i.test(message) ||
    /\bauthentication required\b/i.test(message) ||
    /\b(auth|login|not authenticated|unauthorized)\b/i.test(message) ||
    /\b(401|403)\b/.test(message)
  );
}
