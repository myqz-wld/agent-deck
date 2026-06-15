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

/**
 * Read Claude plan usage without requiring an Agent Deck live session.
 *
 * This starts a Claude SDK Query, sends no user message, calls the `/usage`
 * control request after initialization, then closes the query. It deliberately
 * avoids settings/hooks/MCP/plugin injection so opening the data tab cannot
 * create visible app activity or run user hooks.
 */
export async function readClaudeUsageSnapshotInBackground(): Promise<ProviderUsageSnapshot> {
  const controller = new AbortController();
  let q: Query | null = null;
  let drain: Promise<void> | null = null;

  try {
    const sdk = await loadSdk();
    const runtime = getSdkRuntimeOptions();
    const claudeBinary = resolveClaudeBinary();
    q = sdk.query({
      prompt: idleInput(controller.signal),
      options: {
        cwd: process.cwd(),
        permissionMode: 'plan',
        settingSources: [],
        abortController: controller,
        executable: runtime.executable,
        env: runtime.env,
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });

    drain = drainQuery(q);
    drain.catch((err) => {
      logger.debug('[claude-usage] background query drain ended:', err);
    });

    const usage = await raceWithTimeout({
      work: q
        .initializationResult()
        .then(() => q!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
      timeoutMs: BACKGROUND_USAGE_TIMEOUT_MS,
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

async function drainQuery(q: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of q) {
    // Drain SDK messages so control responses can be processed. Usage data is
    // read through the control response, not from the message stream.
  }
}
