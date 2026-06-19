import type { ProviderUsageSnapshot } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { CodexAppServerClient } from './app-server/client';
import {
  buildCodexUsageSnapshot,
  errorUsageSnapshot,
  unavailableUsageSnapshot,
  type CodexAccountRateLimitsResponseLike,
} from '../provider-usage';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import { getProviderUsageProbeCwd } from '@main/paths';
import log from '@main/utils/logger';

const logger = log.scope('codex-usage');
const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;
const BACKGROUND_USAGE_IDLE_DISPOSE_MS = 5 * 60_000;

type CodexUsageClient = Pick<CodexAppServerClient, 'request' | 'dispose'>;

let cachedUsageClient: CodexUsageClient | null = null;
let cachedUsageClientKey: string | null = null;
let cachedUsageClientIdleTimer: ReturnType<typeof setTimeout> | null = null;

export interface CodexUsageProbeDeps {
  makeClient?: (opts: {
    codexPathOverride: string | null;
    env: Record<string, string>;
    cwd: string;
  }) => CodexUsageClient;
  codexPathOverride?: string | null;
  getProbeCwdFn?: typeof getProviderUsageProbeCwd;
  timeoutMs?: number;
  cacheClient?: boolean;
  idleDisposeMs?: number;
}

function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  out.AGENT_DECK_ORIGIN = 'sdk';
  return out;
}

/**
 * Read Codex account rate limits without creating a Codex thread or turn.
 *
 * This sends only `account/rateLimits/read`; it must not call
 * startThread/resumeThread/run. Production reads reuse a short-lived app-server
 * client because the Codex quota endpoint is unstable when every refresh
 * recreates the process.
 */
export async function readCodexUsageSnapshotInBackground(
  deps: CodexUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const codexPath =
    deps.codexPathOverride !== undefined ? deps.codexPathOverride : settingsStore.get('codexCliPath');
  const codexPathOverride = (codexPath && codexPath.trim()) || null;
  const cwd = (deps.getProbeCwdFn ?? getProviderUsageProbeCwd)();
  const { client, disposeAfterRead } = getCodexUsageClient({
    codexPathOverride,
    cwd,
    deps,
  });

  try {
    const response = await raceWithTimeout({
      work: client.request<CodexAccountRateLimitsResponseLike>(
        'account/rateLimits/read',
        undefined,
      ),
      timeoutMs: deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS,
      errorMessage: '__codex_usage_timeout__',
      onTimeout: () => {
        if (disposeAfterRead) {
          client.dispose();
        } else {
          invalidateCodexUsageSnapshotClient();
        }
      },
    });
    return buildCodexUsageSnapshot(response);
  } catch (err) {
    if (isExpectedCodexUsageUnavailable(err)) {
      logger.debug('[codex-usage] usage snapshot unavailable:', err);
      return unavailableUsageSnapshot(
        'codex-cli',
        'Codex',
        'Codex 额度信息暂不可读，请确认 Codex 已登录且网络可用',
      );
    }
    logger.warn('[codex-usage] usage snapshot failed:', err);
    return errorUsageSnapshot('codex-cli', 'Codex', err);
  } finally {
    if (disposeAfterRead) {
      client.dispose();
    } else if (cachedUsageClient === client) {
      scheduleCachedUsageClientDisposal(deps.idleDisposeMs ?? BACKGROUND_USAGE_IDLE_DISPOSE_MS);
    }
  }
}

export function invalidateCodexUsageSnapshotClient(): void {
  clearCachedUsageClientIdleTimer();
  cachedUsageClient?.dispose();
  cachedUsageClient = null;
  cachedUsageClientKey = null;
}

function getCodexUsageClient(opts: {
  codexPathOverride: string | null;
  cwd: string;
  deps: CodexUsageProbeDeps;
}): { client: CodexUsageClient; disposeAfterRead: boolean } {
  const useCache = opts.deps.cacheClient ?? !opts.deps.makeClient;
  const makeClient = () =>
    opts.deps.makeClient?.({
      codexPathOverride: opts.codexPathOverride,
      env: snapshotProcessEnv(),
      cwd: opts.cwd,
    }) ??
    new CodexAppServerClient({
      codexPathOverride: opts.codexPathOverride,
      config: null,
      env: snapshotProcessEnv(),
      cwd: opts.cwd,
    });

  if (!useCache) {
    return { client: makeClient(), disposeAfterRead: true };
  }

  const key = `${opts.codexPathOverride ?? ''}\n${opts.cwd}`;
  if (!cachedUsageClient || cachedUsageClientKey !== key) {
    invalidateCodexUsageSnapshotClient();
    cachedUsageClient = makeClient();
    cachedUsageClientKey = key;
  }
  clearCachedUsageClientIdleTimer();
  return { client: cachedUsageClient, disposeAfterRead: false };
}

function scheduleCachedUsageClientDisposal(ms: number): void {
  clearCachedUsageClientIdleTimer();
  cachedUsageClientIdleTimer = setTimeout(invalidateCodexUsageSnapshotClient, Math.max(0, ms));
  cachedUsageClientIdleTimer.unref?.();
}

function clearCachedUsageClientIdleTimer(): void {
  if (!cachedUsageClientIdleTimer) return;
  clearTimeout(cachedUsageClientIdleTimer);
  cachedUsageClientIdleTimer = null;
}

function isExpectedCodexUsageUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch codex rate limits/i.test(message) ||
    /backend-api\/wham\/usage/i.test(message) ||
    /\b(auth|login|not authenticated|unauthorized)\b/i.test(message) ||
    /\b(401|403)\b/.test(message)
  );
}
