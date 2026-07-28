import { methods } from '@agentclientprotocol/sdk';
import { sessionManager } from '@main/session/manager';
import type {
  AdapterSessionMode,
  AgentEvent,
} from '@shared/types';

import { GrokAcpProcess, withTimeout } from './acp-process';
import type { GrokExtensionNotification } from './extension';
import { GrokPermissionController } from './permission-controller';
import { currentModelId, currentSessionMode, errorText } from './protocol-utils';
import { resolveGrokBinary } from './resolve-grok-binary';
import { persistGrokUsageWatermark } from './runtime-factory';
import type { GrokRuntime } from './runtime-types';
import {
  buildGrokMcpServers,
  buildGrokSessionMeta,
  type GrokSessionSetupOptions,
} from './session-setup';
import {
  completeGrokTurnLiveRate,
  translateGrokTurnUsage,
  translateGrokUpdate,
} from './translate';

const REQUEST_TIMEOUT_MS = 15_000;

export interface GrokRuntimeStartContext {
  binaryPath: string | null;
  runtimes: ReadonlyMap<string, GrokRuntime>;
  sessionSetup: GrokSessionSetupOptions;
  permissionController: GrokPermissionController;
  emit: (event: AgentEvent) => void;
  emitError: (sessionId: string, text: string) => void;
  isCurrentRuntime: (runtime: GrokRuntime) => boolean;
  requireNativeSession: (runtime: GrokRuntime) => string;
  onNegotiatedImageCapability?: (supported: boolean) => void;
  confirmPromptAccepted: (runtime: GrokRuntime) => void;
  drain: (runtime: GrokRuntime) => Promise<void>;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  /** Test seam; production uses the fixed bounded ACP request timeout. */
  requestTimeoutMs?: number;
}

export async function startGrokRuntime(
  runtime: GrokRuntime,
  context: GrokRuntimeStartContext,
): Promise<boolean> {
  if (!context.isCurrentRuntime(runtime) || runtime.closed) return false;
  runtime.ready = false;
  const requestedMode = runtime.sessionMode;
  let reportedMode: AdapterSessionMode | null = null;
  const binary = await resolveGrokBinary(context.binaryPath);
  if (!context.isCurrentRuntime(runtime) || runtime.closed) return false;
  const process = await GrokAcpProcess.start({
    binary,
    cwd: runtime.cwd,
    sandboxProfile: runtime.grokSandbox,
    onSessionUpdate: (notification) => {
      if (
        context.runtimes.get(runtime.applicationSessionId) !== runtime ||
        !runtime.ready ||
        runtime.suppressUpdates ||
        notification.sessionId !== runtime.nativeSessionId
      ) return;
      if (notification.update.sessionUpdate === 'user_message_chunk') {
        context.confirmPromptAccepted(runtime);
      }
      for (const event of translateGrokUpdate(
        runtime.applicationSessionId,
        runtime.cwd,
        notification.update,
        runtime.translation,
      )) {
        context.emit(event);
      }
    },
    onGrokExtensionUpdate: (notification: GrokExtensionNotification) => {
      try {
        if (
          context.runtimes.get(runtime.applicationSessionId) !== runtime ||
          !runtime.ready ||
          runtime.suppressUpdates ||
          notification.sessionId !== runtime.nativeSessionId
        ) return;
        const previousWatermark = runtime.translation.lastUsage;
        const usageEvent = translateGrokTurnUsage(
          runtime.applicationSessionId,
          runtime.model,
          notification,
          runtime.translation,
        );
        if (!usageEvent && runtime.translation.lastUsage !== previousWatermark) {
          persistGrokUsageWatermark(runtime);
        }
        if (!usageEvent) return;
        // Current-turn events carry their matching cumulative watermark so session manager commits
        // both atomically. A completed-turn correction may carry only the safely advanced historical
        // frontier; it never exposes an in-flight current standard snapshot.
        context.emit(usageEvent);
        const payload = usageEvent.payload as {
          outputTokens?: unknown;
          grokAffectsCurrentTurn?: unknown;
        };
        const usage = notification.update?.usage;
        if (payload.grokAffectsCurrentTurn !== false) {
          completeGrokTurnLiveRate(
            runtime.translation,
            typeof payload.outputTokens === 'number' ? payload.outputTokens : 0,
            typeof usage?.apiDurationMs === 'number' ? usage.apiDurationMs : undefined,
          );
        }
      } catch {
        return;
      }
    },
    onPermissionRequest: (request, signal) =>
      context.permissionController.handle(runtime, request, signal),
  });
  if (!context.isCurrentRuntime(runtime) || runtime.closed) {
    await process.stop();
    return false;
  }
  runtime.process = process;
  runtime.nativeDefaultModel = currentModelId(process.initializeResponse);
  process.onExit((code, signal) => {
    if (
      context.runtimes.get(runtime.applicationSessionId) !== runtime ||
      runtime.process !== process ||
      process.isStopping ||
      runtime.closed
    ) return;
    const diagnostics = process.diagnostics;
    context.emitError(
      runtime.applicationSessionId,
      `Grok ACP exited unexpectedly (${signal ?? code ?? 'unknown'}).${
        diagnostics ? `\n${diagnostics}` : ''
      }`,
    );
    void context.dispose(runtime);
  });
  context.onNegotiatedImageCapability?.(
    process.initializeResponse.agentCapabilities?.promptCapabilities?.image === true,
  );

  const mcpServers = buildGrokMcpServers(
    runtime.applicationSessionId,
    context.sessionSetup,
  );
  const meta = await buildGrokSessionMeta(runtime, context.sessionSetup);
  if (!context.isCurrentRuntime(runtime) || runtime.closed) {
    await process.stop();
    return false;
  }
  if (runtime.nativeSessionId) {
    if (!process.initializeResponse.agentCapabilities?.loadSession) {
      throw new Error('This Grok ACP version cannot load existing sessions.');
    }
    const response = await withTimeout(
      process.connection.agent.request(methods.agent.session.load, {
        sessionId: runtime.nativeSessionId,
        cwd: runtime.cwd,
        mcpServers,
        _meta: meta,
      }),
      REQUEST_TIMEOUT_MS,
      'Grok ACP session/load',
    );
    if (!context.isCurrentRuntime(runtime) || runtime.closed) {
      await process.stop();
      return false;
    }
    applyReportedModel(runtime, currentModelId(response));
    reportedMode = currentSessionMode(response);
    runtime.sessionMode ??= reportedMode;
    runtime.suppressUpdates = false;
  } else {
    const response = await withTimeout(
      process.connection.agent.request(methods.agent.session.new, {
        cwd: runtime.cwd,
        mcpServers,
        _meta: meta,
      }),
      REQUEST_TIMEOUT_MS,
      'Grok ACP session/new',
    );
    if (!context.isCurrentRuntime(runtime) || runtime.closed) {
      await process.stop();
      return false;
    }
    runtime.nativeSessionId = response.sessionId;
    applyReportedModel(runtime, currentModelId(response));
    reportedMode = currentSessionMode(response) ?? 'default';
    runtime.sessionMode ??= reportedMode;
    sessionManager.updateCliSessionId(
      runtime.applicationSessionId,
      response.sessionId,
    );
  }
  if (requestedMode && requestedMode !== reportedMode) {
    const controller = new AbortController();
    try {
      await withTimeout(
        process.connection.agent.request(
          methods.agent.session.setMode,
          {
            sessionId: context.requireNativeSession(runtime),
            modeId: requestedMode,
          },
          { cancellationSignal: controller.signal },
        ),
        context.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        'Grok ACP session/setMode during startup',
      );
    } catch (error) {
      let disposeError: unknown;
      try {
        await context.dispose(runtime);
      } catch (disposeFailure) {
        disposeError = disposeFailure;
      }
      throw new Error(
        `Grok ACP 启动 setMode 结果无法确认：${errorText(error)}。${
          disposeError
            ? ` Runtime 释放也失败：${errorText(disposeError)}`
            : ''
        }`,
        { cause: error },
      );
    } finally {
      controller.abort();
    }
    if (!context.isCurrentRuntime(runtime) || runtime.closed) {
      await process.stop();
      return false;
    }
    runtime.sessionMode = requestedMode;
  }
  if (!context.isCurrentRuntime(runtime) || runtime.closed) {
    await process.stop();
    return false;
  }
  runtime.ready = true;
  void context.drain(runtime);
  return true;
}

function applyReportedModel(
  runtime: GrokRuntime,
  reportedModel: string | null,
): void {
  if (runtime.modelOverride === undefined) {
    runtime.model ??= reportedModel ?? runtime.nativeDefaultModel ?? null;
    return;
  }
  runtime.model =
    runtime.modelOverride ?? reportedModel ?? runtime.nativeDefaultModel ?? null;
}

export async function startGrokRuntimeInBackground(
  runtime: GrokRuntime,
  context: GrokRuntimeStartContext,
  persist: (runtime: GrokRuntime) => void,
): Promise<void> {
  if (!context.isCurrentRuntime(runtime) || runtime.closed) return;
  try {
    if (!(await startGrokRuntime(runtime, context))) return;
    if (!context.isCurrentRuntime(runtime) || runtime.closed) return;
    persist(runtime);
  } catch (error) {
    if (context.isCurrentRuntime(runtime) && !runtime.closed) {
      context.emitError(
        runtime.applicationSessionId,
        `Grok session startup failed: ${errorText(error)}`,
      );
    }
    await context.dispose(runtime);
  }
}
