import type {
  Query,
  SDKControlGetUsageResponse,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderUsageSnapshot } from '@shared/types';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import {
  buildClaudeUsageSnapshot,
  errorUsageSnapshot,
} from '../provider-usage';

const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;
const HOOK_CLAIM_HOLD_MS = 60_000;

export interface ClaudeUsageQuery extends AsyncIterable<unknown> {
  close(): void;
  initializationResult(): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<
    SDKControlGetUsageResponse
  >;
}

export interface ClaudeUsageSdk {
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: {
      cwd: string;
      permissionMode: 'plan';
      settingSources: [];
      abortController: AbortController;
      executable: 'node';
      env: Record<string, string>;
      pathToClaudeCodeExecutable?: string;
    };
  }): ClaudeUsageQuery;
}

export interface ClaudeUsageSnapshotHost {
  loadSdk(): Promise<ClaudeUsageSdk>;
  getRuntimeOptions(): { executable: 'node'; env: Record<string, string> };
  resolveClaudeBinary(): string | undefined;
  getProbeCwd(): string;
  expectSdkSession(cwd: string, ttlMs?: number): () => void;
  now(): number;
}

export interface ClaudeUsageProbeDeps {
  loadSdkFn?: ClaudeUsageSnapshotHost['loadSdk'];
  getRuntimeOptionsFn?: ClaudeUsageSnapshotHost['getRuntimeOptions'];
  resolveClaudeBinaryFn?: ClaudeUsageSnapshotHost['resolveClaudeBinary'];
  getProbeCwdFn?: ClaudeUsageSnapshotHost['getProbeCwd'];
  expectSdkSessionFn?: ClaudeUsageSnapshotHost['expectSdkSession'];
  cwd?: string;
  timeoutMs?: number;
  hookClaimHoldMs?: number;
}

export interface ClaudeLiveUsageSession {
  expectedClose?: boolean;
  query?: Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>;
}

export async function readClaudeBridgeUsageSnapshotCore(
  sessions: ReadonlyMap<string, ClaudeLiveUsageSession>,
  host: Pick<ClaudeUsageSnapshotHost, 'now'>,
  readBackground: () => Promise<ProviderUsageSnapshot>,
): Promise<ProviderUsageSnapshot> {
  const session = [...sessions.values()]
    .reverse()
    .find(
      (candidate) =>
        !candidate.expectedClose
        && typeof candidate.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
          === 'function',
    );
  if (!session?.query) return readBackground();
  try {
    const usage =
      await session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    return buildClaudeUsageSnapshot(usage, host.now());
  } catch (error) {
    return errorUsageSnapshot('claude-code', error, host.now());
  }
}

export async function readClaudeUsageSnapshotInBackgroundCore(
  host: ClaudeUsageSnapshotHost,
  deps: ClaudeUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const loadSdkFn = deps.loadSdkFn ?? host.loadSdk;
  const getRuntimeOptionsFn = deps.getRuntimeOptionsFn ?? host.getRuntimeOptions;
  const resolveClaudeBinaryFn = deps.resolveClaudeBinaryFn ?? host.resolveClaudeBinary;
  const getProbeCwdFn = deps.getProbeCwdFn ?? host.getProbeCwd;
  const expectSdkSessionFn = deps.expectSdkSessionFn ?? host.expectSdkSession;
  const controller = new AbortController();
  const probeCwd = deps.cwd ?? getProbeCwdFn();
  const hookClaimHoldMs = deps.hookClaimHoldMs ?? HOOK_CLAIM_HOLD_MS;
  const releasePendingHookClaim = expectSdkSessionFn(probeCwd, hookClaimHoldMs);
  let query: ClaudeUsageQuery | null = null;
  let drain: Promise<void> | null = null;

  try {
    const sdk = await loadSdkFn();
    const runtime = getRuntimeOptionsFn();
    const claudeBinary = resolveClaudeBinaryFn();
    query = sdk.query({
      prompt: idleInput(controller.signal),
      options: {
        cwd: probeCwd,
        permissionMode: 'plan',
        settingSources: [],
        abortController: controller,
        executable: runtime.executable,
        env: { ...runtime.env, AGENT_DECK_ORIGIN: 'sdk' },
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });

    drain = drainQuery(query, () => {
      controller.abort();
      query?.close();
    });
    void drain.catch(() => undefined);
    const interactionFailure = drain.then<never>(
      () => new Promise<never>(() => undefined),
      (error) => Promise.reject(error),
    );
    const usage = await raceWithTimeout({
      work: Promise.race([
        query.initializationResult().then(
          () => query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        ),
        interactionFailure,
      ]),
      timeoutMs: deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS,
      errorMessage: '__claude_usage_timeout__',
      onTimeout: () => {
        controller.abort();
        query?.close();
      },
    });
    return buildClaudeUsageSnapshot(usage, host.now());
  } catch (error) {
    return errorUsageSnapshot('claude-code', error, host.now());
  } finally {
    controller.abort();
    query?.close();
    holdHookClaimThenRelease(releasePendingHookClaim, hookClaimHoldMs);
    void drain;
  }
}

function holdHookClaimThenRelease(release: () => void, ms: number): void {
  const timer = setTimeout(release, Math.max(0, ms));
  timer.unref?.();
}

function idleInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void, unknown> {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

async function drainQuery(query: AsyncIterable<unknown>, abort: () => void): Promise<void> {
  for await (const message of query) {
    if (!isInteractiveControlRequest(message)) continue;
    abort();
    throw new Error('Claude usage probe requires interactive authentication');
  }
}

function isInteractiveControlRequest(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as { type?: unknown; request?: { subtype?: unknown } };
  if (record.type !== 'control_request') return false;
  const subtype = record.request?.subtype;
  return (
    subtype === 'request_user_dialog'
    || subtype === 'claude_authenticate'
    || subtype === 'claude_oauth_callback'
    || subtype === 'claude_oauth_wait_for_completion'
    || subtype === 'oauth_token_refresh'
    || subtype === 'host_auth_token_refresh'
  );
}
