import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderUsageSnapshot } from '@shared/types';
import { loadSdk } from './sdk-loader';
import { getSdkRuntimeOptions } from './sdk-runtime';
import { resolveClaudeBinary } from './resolve-claude-binary';
import { buildClaudeUsageSnapshot, errorUsageSnapshot } from '../provider-usage';
import { raceWithTimeout } from '@main/session/oneshot-llm/race-with-timeout';
import log from '@main/utils/logger';

const logger = log.scope('claude-usage');
const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;

export interface ClaudeUsageProbeDeps {
  loadSdkFn?: typeof loadSdk;
  getRuntimeOptionsFn?: typeof getSdkRuntimeOptions;
  resolveClaudeBinaryFn?: typeof resolveClaudeBinary;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Read Claude plan usage without creating an Agent Deck session.
 *
 * This starts a streaming-input SDK Query whose input stream yields no user
 * messages. The probe waits for initialization, calls the `/usage` control
 * request, then closes. It must not be wired through createSession(), because
 * createSession requires a non-empty prompt and starts a real user turn.
 */
export async function readClaudeUsageSnapshotInBackground(
  deps: ClaudeUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const loadSdkFn = deps.loadSdkFn ?? loadSdk;
  const getRuntimeOptionsFn = deps.getRuntimeOptionsFn ?? getSdkRuntimeOptions;
  const resolveClaudeBinaryFn = deps.resolveClaudeBinaryFn ?? resolveClaudeBinary;
  const controller = new AbortController();
  let q: Query | null = null;
  let drain: Promise<void> | null = null;

  try {
    const sdk = await loadSdkFn();
    const runtime = getRuntimeOptionsFn();
    const claudeBinary = resolveClaudeBinaryFn();
    q = sdk.query({
      prompt: idleInput(controller.signal),
      options: {
        cwd: deps.cwd ?? process.cwd(),
        permissionMode: 'plan',
        settingSources: ['user', 'project', 'local'],
        abortController: controller,
        executable: runtime.executable,
        env: runtime.env,
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });

    drain = drainQuery(q, () => {
      controller.abort();
      q?.close();
    });
    drain.catch((err) => {
      logger.debug('[claude-usage] background query drain ended:', err);
    });
    const interactionFailure = drain.then<never>(
      () => new Promise<never>(() => undefined),
      (err) => Promise.reject(err),
    );

    const usage = await raceWithTimeout({
      work: Promise.race([
        q
          .initializationResult()
          .then(() => q!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
        interactionFailure,
      ]),
      timeoutMs: deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS,
      errorMessage: '__claude_usage_timeout__',
      onTimeout: () => {
        controller.abort();
        q?.close();
      },
    });
    return buildClaudeUsageSnapshot(usage);
  } catch (err) {
    logger.warn('[claude-usage] background usage snapshot failed:', err);
    return errorUsageSnapshot('claude-code', 'Claude', err);
  } finally {
    controller.abort();
    q?.close();
    // The close() call should make the async iterator settle. Do not await here:
    // a stuck SDK subprocess must not block the provider usage IPC response.
    void drain;
  }
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

async function drainQuery(
  q: AsyncIterable<unknown>,
  abort: () => void,
): Promise<void> {
  for await (const msg of q) {
    if (isInteractiveControlRequest(msg)) {
      abort();
      throw new Error('Claude usage probe requires interactive authentication');
    }
  }
}

function isInteractiveControlRequest(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const obj = msg as { type?: unknown; request?: { subtype?: unknown } };
  if (obj.type !== 'control_request') return false;
  const subtype = obj.request?.subtype;
  return (
    subtype === 'request_user_dialog' ||
    subtype === 'claude_authenticate' ||
    subtype === 'claude_oauth_callback' ||
    subtype === 'claude_oauth_wait_for_completion' ||
    subtype === 'oauth_token_refresh' ||
    subtype === 'host_auth_token_refresh'
  );
}
