import { methods } from '@agentclientprotocol/sdk';
import type { SessionModelOptions } from '@main/adapters/session-model-options';
import type { AdapterSessionMode } from '@shared/types';

import { withTimeout } from './acp-process';
import { asRecord, errorText } from './protocol-utils';
import { grokRuntimeIdentity } from './runtime-identity';
import type { GrokRuntime } from './runtime-types';

const REQUEST_TIMEOUT_MS = 15_000;

export type GrokRuntimeMutationErrorCode =
  | 'default-unavailable'
  | 'remote-state-unknown';

export class GrokRuntimeMutationError extends Error {
  constructor(
    readonly code: GrokRuntimeMutationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GrokRuntimeMutationError';
  }
}

interface PersistedGrokOptions {
  model: string | null;
  thinking: string | null;
  sessionMode: AdapterSessionMode | null;
}

interface GrokRuntimeMutationContext {
  getRuntime: (sessionId: string) => GrokRuntime | null;
  getPersistedOptions: (sessionId: string) => PersistedGrokOptions | null;
  persistModelOptions: (
    sessionId: string,
    model: string | null,
    thinking: string | null,
  ) => void;
  persistSessionMode: (sessionId: string, mode: AdapterSessionMode) => void;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  requestTimeoutMs?: number;
}

interface EffectiveModelSelection {
  model: string;
  thinking: string | null;
}

/** Serial provider → durable state mutations with compensating provider rollback. */
export class GrokRuntimeMutationController {
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly context: GrokRuntimeMutationContext) {}

  async setModelOptions(
    sessionId: string,
    options: SessionModelOptions,
  ): Promise<void> {
    await this.exclusive(sessionId, () =>
      this.withRuntimeLease(sessionId, () =>
        this.setModelOptionsExclusive(sessionId, options),
      ),
    );
  }

  async setSessionMode(
    sessionId: string,
    mode: AdapterSessionMode,
  ): Promise<void> {
    await this.exclusive(sessionId, () =>
      this.withRuntimeLease(sessionId, () =>
        this.setSessionModeExclusive(sessionId, mode),
      ),
    );
  }

  private async setModelOptionsExclusive(
    sessionId: string,
    options: SessionModelOptions,
  ): Promise<void> {
    if (options.provider !== null) {
      throw new Error('Grok Build does not support a separate runtime provider');
    }
    const persisted = this.requirePersistedOptions(sessionId);
    const runtime = this.context.getRuntime(sessionId);
    if (!runtime) {
      this.context.persistModelOptions(
        sessionId,
        options.model,
        options.thinking,
      );
      return;
    }
    this.assertMutable(runtime);
    const previousOverride = {
      model:
        runtime.modelOverride === undefined
          ? persisted.model
          : runtime.modelOverride,
      thinking:
        runtime.thinkingOverride === undefined
          ? persisted.thinking
          : runtime.thinkingOverride,
    };
    if (
      previousOverride.model === options.model &&
      previousOverride.thinking === options.thinking
    ) {
      this.context.persistModelOptions(
        sessionId,
        options.model,
        options.thinking,
      );
      return;
    }

    const target = this.effectiveSelection(runtime, options);
    const previous = this.effectiveSelection(runtime, {
      provider: null,
      ...previousOverride,
    });
    runtime.runtimeIdentity = null;
    let targetModel: string;
    try {
      targetModel = await this.requestModel(
        runtime,
        target,
        'Grok ACP session/set_model',
      );
    } catch (error) {
      return this.disposeUnknown(
        runtime,
        `Grok 模型切换结果无法确认：${errorText(error)}`,
        error,
      );
    }

    try {
      this.context.persistModelOptions(
        sessionId,
        options.model,
        options.thinking,
      );
    } catch (persistError) {
      try {
        const rollbackModel = await this.requestModel(
          runtime,
          previous,
          'Grok ACP session/set_model rollback',
        );
        this.context.persistModelOptions(
          sessionId,
          previousOverride.model,
          previousOverride.thinking,
        );
        runtime.runtimeIdentity = grokRuntimeIdentity(rollbackModel);
      } catch (rollbackError) {
        await this.disposeUnknown(
          runtime,
          `Grok 模型设置已到达 provider，但持久化或回滚无法确认。` +
            `持久化错误：${errorText(persistError)}；回滚错误：${errorText(rollbackError)}`,
          persistError,
        );
      }
      throw persistError;
    }

    runtime.model = targetModel;
    runtime.runtimeIdentity = grokRuntimeIdentity(targetModel);
    runtime.modelOverride = options.model;
    runtime.thinking = options.thinking;
    runtime.thinkingOverride = options.thinking;
  }

  private async setSessionModeExclusive(
    sessionId: string,
    mode: AdapterSessionMode,
  ): Promise<void> {
    const persisted = this.requirePersistedOptions(sessionId);
    const runtime = this.context.getRuntime(sessionId);
    if (!runtime) {
      this.context.persistSessionMode(sessionId, mode);
      return;
    }
    this.assertMutable(runtime);
    const previous = runtime.sessionMode ?? persisted.sessionMode;
    if (previous === mode) {
      this.context.persistSessionMode(sessionId, mode);
      return;
    }
    if (previous === null) {
      throw new GrokRuntimeMutationError(
        'default-unavailable',
        'Grok ACP 未报告当前 session mode，无法安全回滚此次切换。',
      );
    }

    try {
      await this.requestMode(runtime, mode, 'Grok ACP session/setMode');
    } catch (error) {
      try {
        this.context.persistSessionMode(sessionId, previous);
      } catch (persistError) {
        await this.disposeUnknown(
          runtime,
          `Grok session mode 结果未知，且旧 DB 设置恢复失败：${errorText(persistError)}`,
          error,
        );
      }
      await this.disposeUnknown(
        runtime,
        `Grok session mode 切换结果无法确认：${errorText(error)}`,
        error,
      );
    }

    try {
      this.context.persistSessionMode(sessionId, mode);
    } catch (persistError) {
      try {
        await this.requestMode(
          runtime,
          previous,
          'Grok ACP session/setMode rollback',
        );
        this.context.persistSessionMode(sessionId, previous);
      } catch (rollbackError) {
        await this.disposeUnknown(
          runtime,
          `Grok session mode 已到达 provider，但持久化或回滚无法确认。` +
            `持久化错误：${errorText(persistError)}；回滚错误：${errorText(rollbackError)}`,
          persistError,
        );
      }
      throw persistError;
    }
    runtime.sessionMode = mode;
  }

  private effectiveSelection(
    runtime: GrokRuntime,
    options: SessionModelOptions,
  ): EffectiveModelSelection {
    const model = options.model ?? runtime.nativeDefaultModel ?? null;
    if (!model) {
      throw new GrokRuntimeMutationError(
        'default-unavailable',
        'Grok ACP 未报告原生默认模型，无法安全清空模型覆盖。',
      );
    }
    return { model, thinking: options.thinking };
  }

  private async requestModel(
    runtime: GrokRuntime,
    selection: EffectiveModelSelection,
    label: string,
  ): Promise<string> {
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        runtime.process!.connection.agent.request<
          { modelId?: string; reasoningEffort?: string | null },
          {
            sessionId: string;
            modelId: string;
            _meta?: { reasoningEffort: string };
          }
        >(
          'session/set_model',
          {
            sessionId: this.requireNativeSession(runtime),
            modelId: selection.model,
            ...(selection.thinking
              ? { _meta: { reasoningEffort: selection.thinking } }
              : {}),
          },
          { cancellationSignal: controller.signal },
        ),
        this.context.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        label,
      );
      const result = asRecord(response);
      const reportedModel = result.modelId;
      const reportedThinking = result.reasoningEffort;
      if (
        reportedModel !== selection.model ||
        !('reasoningEffort' in result) ||
        reportedThinking !== selection.thinking
      ) {
        throw new Error(
          `${label} returned an unverified selection ` +
            `(model=${String(reportedModel)}, thinking=${String(reportedThinking)})`,
        );
      }
      return reportedModel;
    } finally {
      controller.abort();
    }
  }

  private async requestMode(
    runtime: GrokRuntime,
    mode: AdapterSessionMode,
    label: string,
  ): Promise<void> {
    const controller = new AbortController();
    try {
      await withTimeout(
        runtime.process!.connection.agent.request(
          methods.agent.session.setMode,
          {
            sessionId: this.requireNativeSession(runtime),
            modeId: mode,
          },
          { cancellationSignal: controller.signal },
        ),
        this.context.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        label,
      );
    } finally {
      controller.abort();
    }
  }

  private async disposeUnknown(
    runtime: GrokRuntime,
    message: string,
    cause: unknown,
  ): Promise<never> {
    runtime.runtimeIdentity = null;
    let disposeError: unknown;
    try {
      await this.context.dispose(runtime);
    } catch (error) {
      disposeError = error;
    }
    throw new GrokRuntimeMutationError(
      'remote-state-unknown',
      `${message}。会话已进入显式释放流程，请重新发送以从持久化设置恢复。${
        disposeError
          ? ` 释放错误：${errorText(disposeError)}`
          : ''
      }`,
      cause,
    );
  }

  private requirePersistedOptions(sessionId: string): PersistedGrokOptions {
    const persisted = this.context.getPersistedOptions(sessionId);
    if (!persisted) {
      throw new Error(`Grok session ${sessionId} 不可用。`);
    }
    return persisted;
  }

  private assertMutable(runtime: GrokRuntime): void {
    if (
      !runtime.process ||
      !runtime.ready ||
      runtime.closed ||
      runtime.disposed ||
      runtime.restartingSandbox ||
      runtime.cwdTransitionGeneration != null
    ) {
      throw new Error(
        `Grok session ${runtime.applicationSessionId} is not active.`,
      );
    }
  }

  private async withRuntimeLease(
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const runtime = this.context.getRuntime(sessionId);
    if (!runtime) {
      await work();
      return;
    }
    this.assertMutable(runtime);
    if (runtime.runtimeMutationInProgress) {
      throw new Error(
        `Grok session ${runtime.applicationSessionId} 已有 runtime 设置事务正在执行。`,
      );
    }
    runtime.runtimeMutationInProgress = true;
    try {
      await work();
    } finally {
      runtime.runtimeMutationInProgress = false;
    }
  }

  private requireNativeSession(runtime: GrokRuntime): string {
    if (!runtime.nativeSessionId) {
      throw new Error(
        `Grok session ${runtime.applicationSessionId} has no native session id.`,
      );
    }
    return runtime.nativeSessionId;
  }

  private async exclusive(
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    let preceding = this.operations.get(sessionId);
    while (preceding) {
      try {
        await preceding;
      } catch {
        // A bounded mutation may proceed after its predecessor rolled back or disposed.
      }
      preceding = this.operations.get(sessionId);
    }
    const operation = work();
    this.operations.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.operations.get(sessionId) === operation) {
        this.operations.delete(sessionId);
      }
    }
  }
}
