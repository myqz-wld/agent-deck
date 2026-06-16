import type { ProviderUsageSnapshot } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { CodexAppServerClient } from './app-server/client';
import {
  buildCodexUsageSnapshot,
  errorUsageSnapshot,
  type CodexAccountRateLimitsResponseLike,
} from '../provider-usage';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import { getProviderUsageProbeCwd } from '@main/paths';
import log from '@main/utils/logger';

const logger = log.scope('codex-usage');
const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;

export interface CodexUsageProbeDeps {
  makeClient?: (opts: {
    codexPathOverride: string | null;
    env: Record<string, string>;
    cwd: string;
  }) => Pick<CodexAppServerClient, 'request' | 'dispose'>;
  codexPathOverride?: string | null;
  getProbeCwdFn?: typeof getProviderUsageProbeCwd;
  timeoutMs?: number;
}

function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Read Codex account rate limits without creating a Codex thread or turn.
 *
 * This initializes a transient app-server client and sends only
 * `account/rateLimits/read`. It must not call startThread/resumeThread/run.
 */
export async function readCodexUsageSnapshotInBackground(
  deps: CodexUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const codexPath =
    deps.codexPathOverride !== undefined ? deps.codexPathOverride : settingsStore.get('codexCliPath');
  const codexPathOverride = (codexPath && codexPath.trim()) || null;
  const cwd = (deps.getProbeCwdFn ?? getProviderUsageProbeCwd)();
  const client =
    deps.makeClient?.({
      codexPathOverride,
      env: snapshotProcessEnv(),
      cwd,
    }) ??
    new CodexAppServerClient({
      codexPathOverride,
      config: null,
      env: snapshotProcessEnv(),
      cwd,
    });

  try {
    const response = await raceWithTimeout({
      work: client.request<CodexAccountRateLimitsResponseLike>(
        'account/rateLimits/read',
        undefined,
      ),
      timeoutMs: deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS,
      errorMessage: '__codex_usage_timeout__',
      onTimeout: () => client.dispose(),
    });
    return buildCodexUsageSnapshot(response);
  } catch (err) {
    logger.warn('[codex-usage] usage snapshot failed:', err);
    return errorUsageSnapshot('codex-cli', 'Codex', err);
  } finally {
    client.dispose();
  }
}
