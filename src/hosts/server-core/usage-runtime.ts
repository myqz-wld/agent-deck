import {
  AgentDeckClientErrorCode,
  isCoreMethodGranted,
  isJsonValue,
  parseUsageProviderParams,
  parseUsageProviderResult,
  parseUsageTokenParams,
  parseUsageTokenResult,
  SessionConsoleContractError,
  USAGE_RATE_MAX_ITEMS,
  type CoreMethod,
  type UsageProviderSnapshotDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import {
  errorUsageSnapshot,
  providerUsageLabel,
  unavailableUsageSnapshot,
} from '@main/adapters/provider-usage';
import type { AgentAdapter } from '@main/adapters/types';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import { WINDOW_MS } from '@shared/model-normalize';
import { PROVIDER_USAGE_CACHE_TTL_MS } from '@shared/constants/provider-usage';
import type { TokenDailyRow, TokenRateRow } from '@shared/types';

export const SERVER_CORE_USAGE_METHODS = Object.freeze([
  'usage.tokens.get',
  'usage.providers.get',
] as const satisfies readonly CoreMethod[]);

type UsageMethod = (typeof SERVER_CORE_USAGE_METHODS)[number];
const PROVIDER_ORDER = ['claude-code', 'codex-cli', 'grok-build'] as const;
// Provider-owned background probes allow up to 15 seconds. Keep the Core fence longer so it
// bounds a wedged adapter without pre-empting a healthy cold Codex/Claude process startup.
const PROVIDER_READ_TIMEOUT_MS = 20_000;

export interface ServerCoreUsageRuntimeOptions {
  readonly tokenUsage: {
    ratesSince(sinceMs: number): TokenRateRow[];
    today(startMs: number): TokenRateRow[];
    dailyByModel(): TokenDailyRow[];
  };
  readonly registry: { get(id: string): AgentAdapter | undefined };
  readonly currentRevision: () => number;
}

function usageMethod(method: CoreMethod): method is UsageMethod {
  return (SERVER_CORE_USAGE_METHODS as readonly CoreMethod[]).includes(method);
}

function startOfTodayLocalMs(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Remote-owner token ledger and provider quota reads for the authoritative Core. */
export class ServerCoreUsageRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  private providerCache: { fetchedAt: number; snapshots: UsageProviderSnapshotDto[] } | null = null;
  private providerRead: Promise<UsageProviderSnapshotDto[]> | null = null;

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreUsageRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_USAGE_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> {
    this.providerCache = null;
    this.providerRead = null;
    return this.base.stop(reason);
  }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!usageMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    try {
      return input.method === 'usage.tokens.get'
        ? this.tokens(input)
        : await this.providers(input);
    } catch (error) {
      if (error instanceof DaemonRequestError) throw error;
      if (error instanceof SessionConsoleContractError) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
      }
      throw error;
    }
  }

  private tokens(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseUsageTokenParams(input.params);
    const revision = this.options.currentRevision();
    const now = new Date();
    const allDaily = params.includeDaily ? this.options.tokenUsage.dailyByModel() : [];
    const result = parseUsageTokenResult({
      rates: this.options.tokenUsage.ratesSince(now.getTime() - WINDOW_MS)
        .slice(0, USAGE_RATE_MAX_ITEMS),
      topToday: this.options.tokenUsage.today(startOfTodayLocalMs(now))
        .slice(0, USAGE_RATE_MAX_ITEMS),
      daily: allDaily.slice(0, params.dailyLimit),
      dailyTruncated: allDaily.length > params.dailyLimit,
      today: localDay(now),
      revision,
    }, params.dailyLimit);
    return this.result(result, revision);
  }

  private async providers(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseUsageProviderParams(input.params);
    const now = Date.now();
    let snapshots: UsageProviderSnapshotDto[];
    if (!params.force && this.providerCache && now - this.providerCache.fetchedAt < PROVIDER_USAGE_CACHE_TTL_MS) {
      snapshots = this.providerCache.snapshots;
    } else {
      snapshots = await this.readProviders();
      if (input.signal.aborted) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
      }
      this.providerCache = { fetchedAt: Date.now(), snapshots };
    }
    const revision = this.options.currentRevision();
    return this.result(parseUsageProviderResult({ snapshots, revision }), revision);
  }

  private readProviders(): Promise<UsageProviderSnapshotDto[]> {
    if (this.providerRead) return this.providerRead;
    this.providerRead = Promise.all(PROVIDER_ORDER.map((provider) => this.readProvider(provider)))
      .finally(() => { this.providerRead = null; });
    return this.providerRead;
  }

  private async readProvider(provider: (typeof PROVIDER_ORDER)[number]): Promise<UsageProviderSnapshotDto> {
    const adapter = this.options.registry.get(provider);
    if (!adapter?.getUsageSnapshot) {
      return unavailableUsageSnapshot(
        provider,
        `${providerUsageLabel(provider)} 暂不支持读取额度信息`,
      );
    }
    try {
      return await raceWithTimeout({
        work: adapter.getUsageSnapshot(),
        timeoutMs: PROVIDER_READ_TIMEOUT_MS,
        errorMessage: 'provider usage read timed out',
      });
    } catch (error) {
      return errorUsageSnapshot(provider, error);
    }
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Usage result is not JSON-safe');
    return { result: value, revision };
  }
}
