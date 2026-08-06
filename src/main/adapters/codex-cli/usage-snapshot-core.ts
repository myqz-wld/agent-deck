import type { ProviderUsageSnapshot } from '@shared/types';
import { PROVIDER_USAGE_REFETCH_MS } from '@shared/constants/provider-usage';
import {
  createCodexUsageProbeStore,
  type CodexUsageClient,
} from './usage-probe-store';

const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;
const BACKGROUND_USAGE_IDLE_DISPOSE_MS = PROVIDER_USAGE_REFETCH_MS;
const usageProbeStore = createCodexUsageProbeStore();

export interface CodexUsageClientOptions {
  codexPathOverride: string | null;
  config: null;
  env: Record<string, string>;
  cwd: string;
}

export interface CodexUsageSnapshotHost {
  createClient(options: CodexUsageClientOptions): CodexUsageClient;
  readCodexCliPath(): string | null;
  readProbeCwd(): string;
  snapshotProcessEnv(): Record<string, string>;
}

export interface CodexUsageProbeDeps {
  makeClient?: (opts: {
    codexPathOverride: string | null;
    env: Record<string, string>;
    cwd: string;
  }) => CodexUsageClient;
  codexPathOverride?: string | null;
  getProbeCwdFn?: () => string;
  timeoutMs?: number;
  cacheClient?: boolean;
  idleDisposeMs?: number;
}

/** Read Codex account limits without discovering desktop process state. */
export function readCodexUsageSnapshotWithHost(
  host: CodexUsageSnapshotHost,
  deps: CodexUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const configuredPath =
    deps.codexPathOverride !== undefined
      ? deps.codexPathOverride
      : host.readCodexCliPath();
  const codexPathOverride = configuredPath?.trim() || null;
  const cwd = (deps.getProbeCwdFn ?? host.readProbeCwd)();
  return usageProbeStore.read({
    clientKey: `${codexPathOverride ?? ''}\n${cwd}`,
    makeClient: () => makeUsageClient(host, deps, codexPathOverride, cwd),
    cacheClient: deps.cacheClient ?? !deps.makeClient,
    timeoutMs: deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS,
    idleDisposeMs: deps.idleDisposeMs ?? BACKGROUND_USAGE_IDLE_DISPOSE_MS,
  });
}

export function invalidateCodexUsageSnapshotClient(): void {
  usageProbeStore.invalidate();
}

function makeUsageClient(
  host: CodexUsageSnapshotHost,
  deps: CodexUsageProbeDeps,
  codexPathOverride: string | null,
  cwd: string,
): CodexUsageClient {
  const env = {
    ...host.snapshotProcessEnv(),
    AGENT_DECK_ORIGIN: 'sdk',
  };
  if (deps.makeClient) {
    return deps.makeClient({ codexPathOverride, env, cwd });
  }
  return host.createClient({ codexPathOverride, config: null, env, cwd });
}
