import type { CodexAppServerClient } from './client';
import type { CodexAppServerThreadCreateResult } from './protocol';
import { buildThreadResumeParams, buildThreadStartParams } from './thread-params';
import type { CodexRuntimeIdentityTracker } from './runtime-identity';
import type { CodexThreadMode } from './thread-mode';

export interface CodexThreadReadinessState {
  promise: Promise<string> | null;
  generation: number;
  configurationRevision: number;
  promiseConfigurationRevision: number;
  configurationRefreshPending: boolean;
}

export function createCodexThreadReadinessState(
  attachedGeneration: number | undefined,
  threadId: string | null,
): CodexThreadReadinessState {
  return {
    promise: attachedGeneration !== undefined && threadId ? Promise.resolve(threadId) : null,
    generation: attachedGeneration ?? -1,
    configurationRevision: 0,
    promiseConfigurationRevision: 0,
    configurationRefreshPending: false,
  };
}

export function stageCodexThreadConfiguration(state: CodexThreadReadinessState): void {
  state.configurationRevision += 1;
  state.configurationRefreshPending = true;
}

export async function ensureCodexThreadReady(input: {
  client: CodexAppServerClient;
  getMode(): CodexThreadMode;
  getThreadId(): string | null;
  setThreadId(threadId: string): void;
  runtimeIdentity: CodexRuntimeIdentityTracker;
  signal?: AbortSignal;
  state: CodexThreadReadinessState;
}): Promise<string> {
  const { client, state } = input;
  while (true) {
    const generation = client.generation;
    const revision = state.configurationRevision;
    if (state.promise && state.generation === generation) {
      const readyRevision = state.promiseConfigurationRevision;
      const ready = input.signal
        ? await client.runGenerationOperation(
            'thread readiness wait', input.signal, async () => state.promise!,
          )
        : await state.promise;
      if (readyRevision === state.configurationRevision) {
        state.configurationRefreshPending = false;
        return ready;
      }
      if (state.promiseConfigurationRevision === readyRevision) state.promise = null;
      continue;
    }

    state.generation = generation;
    state.promiseConfigurationRevision = revision;
    const options = input.getMode().options;
    const currentThreadId = input.getThreadId();
    const attempt = client.runGenerationOperation(
      currentThreadId ? 'thread/resume readiness' : 'thread/start readiness', input.signal,
      async (operation) => {
        const result = await operation.request<CodexAppServerThreadCreateResult>(
          currentThreadId ? 'thread/resume' : 'thread/start',
          currentThreadId
            ? buildThreadResumeParams(currentThreadId, options, client.baseConfig)
            : buildThreadStartParams(options, client.baseConfig),
        );
        input.runtimeIdentity.observeThreadBoundary(result, options);
        input.setThreadId(result.thread.id);
        return result.thread.id;
      },
    );
    state.promise = attempt;
    try {
      const ready = await attempt;
      if (revision === state.configurationRevision) {
        state.configurationRefreshPending = false;
        return ready;
      }
      if (state.promise === attempt) state.promise = null;
    } catch (error) {
      // A retry must issue a fresh boundary RPC after a same-generation readiness rejection.
      if (state.promise === attempt) {
        state.promise = null;
        state.generation = -1;
      }
      throw error;
    }
  }
}
