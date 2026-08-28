import { methods } from '@agentclientprotocol/sdk';
import type {
  AdapterSessionMode,
  AgentEvent,
} from '@shared/types';

import {
  GrokAcpProcess,
  withTimeout,
  type GrokAcpClientOptions,
  type GrokAcpSession,
  type GrokAcpSessionFactory,
} from './acp-process';
import { scheduleGrokContextUsageRefresh } from './context-usage';
import type {
  GrokExtensionNotification,
  GrokPromptCompleteNotification,
} from './extension';
import { GrokPermissionController } from './permission-controller';
import { currentModelId, currentSessionMode, errorText } from './protocol-utils';
import { resolveGrokBinary } from './resolve-grok-binary';
import { persistGrokUsageWatermark } from './runtime-factory';
import { applyGrokNegotiatedModel } from './runtime-identity';
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
import { commandsFromGrokUpdate } from './session-commands';
import type { GrokSessionManagerPort } from './bridge-options';
import {
  NOOP_GROK_BRIDGE_RUNTIME_HOST,
  type GrokBridgeRuntimeHost,
} from './bridge-runtime-core';

const REQUEST_TIMEOUT_MS = 15_000;
export interface GrokRuntimeStartContext {
  sessionManager: Pick<GrokSessionManagerPort, 'updateCliSessionId'>;
  runtimeHost?: GrokBridgeRuntimeHost;
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
  observeModelActivity: (
    runtime: GrokRuntime,
    update: Parameters<typeof translateGrokUpdate>[2],
  ) => void;
  observePromptComplete: (
    runtime: GrokRuntime,
    notification: GrokPromptCompleteNotification | GrokExtensionNotification,
  ) => void;
  drain: (runtime: GrokRuntime) => Promise<void>;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  /** Test seam; production uses the fixed bounded ACP request timeout. */
  requestTimeoutMs?: number;
  /** Trusted host seam for a Provider-container ACP channel. Native/local paths omit it. */
  processFactory?: GrokAcpSessionFactory;
}

export async function startGrokRuntime(
  runtime: GrokRuntime,
  context: GrokRuntimeStartContext,
): Promise<boolean> {
  const runtimeHost = context.runtimeHost ?? NOOP_GROK_BRIDGE_RUNTIME_HOST;
  const logger = runtimeHost.diagnostics.scope('grok-runtime');
  if (!context.isCurrentRuntime(runtime) || runtime.closed) return false;
  runtime.ready = false;
  runtime.runtimeIdentity = null;
  runtime.nativeDefaultModel = null;
  const requestedMode = runtime.sessionMode;
  const sandboxProfile = runtime.grokSandbox;
  let reportedMode: AdapterSessionMode | null = null;
  const clientOptions: GrokAcpClientOptions = {
    onSessionUpdate: (notification) => {
      if (
        context.runtimes.get(runtime.applicationSessionId) !== runtime ||
        !runtime.ready ||
        runtime.suppressUpdates ||
        notification.sessionId !== runtime.nativeSessionId
      ) return;
      context.observeModelActivity(runtime, notification.update);
      if (notification.update.sessionUpdate === 'user_message_chunk') {
        context.confirmPromptAccepted(runtime);
      }
      const commands = commandsFromGrokUpdate(notification.update);
      if (commands) runtime.availableCommands = commands;
      for (const event of translateGrokUpdate(
        runtime.applicationSessionId,
        runtime.cwd,
        notification.update,
        runtime.translation,
        runtime.runtimeIdentity,
      )) {
        context.emit(event);
      }
    },
    onSessionUpdateError: (error, notification) => {
      logger.warn('[grok-runtime] session update callback failed; stream preserved', {
        event: 'grok_session_update_callback_failed',
        sessionId: runtime.applicationSessionId,
        nativeSessionId: runtime.nativeSessionId,
        notificationSessionId: notification.sessionId,
        updateType: notification.update.sessionUpdate,
        error: errorText(error),
      });
    },
    onGrokExtensionUpdate: (notification: GrokExtensionNotification) => {
      try {
        if (
          context.runtimes.get(runtime.applicationSessionId) !== runtime ||
          !runtime.ready ||
          runtime.suppressUpdates ||
          notification.sessionId !== runtime.nativeSessionId
        ) return;
        // Grok 0.2.114 uses this extension update itself as the only live terminal on
        // rate-limit and some completed turns; prompt_complete is not guaranteed.
        context.observePromptComplete(runtime, notification);
        const previousWatermark = runtime.translation.lastUsage;
        const usageEvent = translateGrokTurnUsage(
          runtime.applicationSessionId,
          runtime.model,
          notification,
          runtime.translation,
        );
        if (!usageEvent && runtime.translation.lastUsage !== previousWatermark) {
          persistGrokUsageWatermark(runtime, runtimeHost);
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
    onGrokPromptComplete: (notification: GrokPromptCompleteNotification) => {
      try {
        if (
          context.runtimes.get(runtime.applicationSessionId) !== runtime ||
          !runtime.ready ||
          runtime.suppressUpdates ||
          notification.sessionId !== runtime.nativeSessionId
        ) return;
        context.observePromptComplete(runtime, notification);
      } catch (error) {
        logger.warn('[grok-runtime] prompt-complete callback failed; stream preserved', {
          event: 'grok_prompt_complete_callback_failed',
          sessionId: runtime.applicationSessionId,
          nativeSessionId: runtime.nativeSessionId,
          notificationSessionId: notification.sessionId,
          turnId: notification.turnId,
          error: errorText(error),
        });
      }
    },
    onPermissionRequest: (request, signal) =>
      context.permissionController.handle(runtime, request, signal),
  };
  let sessionCwd = runtime.cwd;
  let allowAgentDeckMcp = true;
  let allowHostPathMetadata = true;
  let process: GrokAcpSession;
  if (context.processFactory) {
    const launched = await context.processFactory({
      ...clientOptions,
      applicationSessionId: runtime.applicationSessionId,
      cwd: runtime.cwd,
      sandboxProfile,
    });
    process = launched.process;
    sessionCwd = launched.sessionCwd;
    allowAgentDeckMcp = launched.allowAgentDeckMcp;
    allowHostPathMetadata = launched.allowHostPathMetadata;
  } else {
    const binary = await resolveGrokBinary(context.binaryPath);
    if (!context.isCurrentRuntime(runtime) || runtime.closed) return false;
    const browserEnvironment = runtimeHost.prepareBrowserRuntimeEnvironment?.(
      runtime.applicationSessionId,
    ) ?? null;
    try {
      process = await GrokAcpProcess.start({
        ...clientOptions,
        binary,
        cwd: runtime.cwd,
        ...(browserEnvironment ? { environment: browserEnvironment } : {}),
        sandboxProfile,
      });
    } catch (error) {
      runtimeHost.revokeBrowserRuntime?.(runtime.applicationSessionId);
      throw error;
    }
  }
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

  const mcpServers = allowAgentDeckMcp
    ? buildGrokMcpServers(runtime.applicationSessionId, context.sessionSetup)
    : [];
  const builtMeta = await buildGrokSessionMeta(runtime, context.sessionSetup);
  const meta = allowHostPathMetadata
    ? builtMeta
    : Object.fromEntries(Object.entries(builtMeta).filter(([key]) => key !== 'pluginDirs'));
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
        cwd: sessionCwd,
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
    applyGrokNegotiatedModel(runtime, currentModelId(response));
    reportedMode = currentSessionMode(response);
    runtime.sessionMode ??= reportedMode;
  } else {
    const response = await withTimeout(
      process.connection.agent.request(methods.agent.session.new, {
        cwd: sessionCwd,
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
    applyGrokNegotiatedModel(runtime, currentModelId(response));
    reportedMode = currentSessionMode(response) ?? 'default';
    runtime.sessionMode ??= reportedMode;
    context.sessionManager.updateCliSessionId(
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
  // Both load and new paths are fully committed here. Leaving this branch-specific previously
  // allowed a stale suppression flag to discard every live model update while a prompt ran.
  runtime.suppressUpdates = false;
  runtime.activeGrokSandbox = sandboxProfile;
  runtime.ready = true;
  scheduleGrokContextUsageRefresh(runtime, {
    diagnostics: runtimeHost.diagnostics,
    emit: context.emit,
    isCurrentRuntime: context.isCurrentRuntime,
    requestTimeoutMs: context.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  });
  void context.drain(runtime);
  return true;
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
