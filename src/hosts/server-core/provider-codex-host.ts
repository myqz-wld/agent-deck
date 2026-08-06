import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { createCodexCliAdapterHost } from '@main/adapters/codex-cli/aggregate-host-core';
import { CodexAppServerClient } from '@main/adapters/codex-cli/app-server/client';
import { NOOP_CODEX_CLIENT_DIAGNOSTICS } from '@main/adapters/codex-cli/app-server/client-diagnostics-port';
import { NOOP_CODEX_GENERATION_DIAGNOSTICS } from '@main/adapters/codex-cli/app-server/generation-operation';
import type { CodexAppServerOptions } from '@main/adapters/codex-cli/app-server/protocol';
import { CodexAppServerThread } from '@main/adapters/codex-cli/app-server/thread';
import type { CodexThreadMode } from '@main/adapters/codex-cli/app-server/thread-mode';
import { buildCodexWorkspaceAppServerArguments } from '@main/adapters/codex-cli/app-server/workspace-permissions';
import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import type {
  CodexThreadOptions,
  CodexWorkspacePermissionBoundary,
} from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';
import {
  ensureCodexClientWithHost,
  type CodexClientConstructionHost,
} from '@main/adapters/codex-cli/sdk-bridge/client-construction';
import { resolveCodexModelProvider } from '@main/codex-config/model-providers';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from '@shared/types';
import { unavailableUsageSnapshot } from '@main/adapters/provider-usage';
import {
  providerProcessEnvironment,
  providerLogger,
  publishProviderSession,
  unsupportedRecoveryHost,
  type ServerCoreProviderHostInput,
} from './provider-host-common';

export const HEADLESS_CODEX_EXECUTABLE = '/opt/agent-deck/providers/codex/codex';

function frozenWorkspacePermissionBoundary(
  input: ServerCoreProviderHostInput,
): CodexWorkspacePermissionBoundary {
  return Object.freeze({
    workspaceRoot: input.workspaceBoundary.workspaceRoot,
    readOnlyRoots: Object.freeze([...input.workspaceBoundary.runtimeReadRoots]),
    // Provider state remains outside the model-facing filesystem. Commands can use workspace-local
    // scratch space; they must never receive a path into Worker/Core private state.
    readWriteRoots: Object.freeze([]),
  });
}

export function withServerCoreCodexWorkspaceBoundary(
  mode: CodexThreadMode,
  input: ServerCoreProviderHostInput,
): CodexThreadMode {
  const options: CodexThreadOptions = Object.freeze({
    ...mode.options,
    runtimeWorkspaceRoots: Object.freeze([input.workspaceBoundary.workspaceRoot]),
    workspacePermissionBoundary: frozenWorkspacePermissionBoundary(input),
  });
  return mode.mode === 'resume'
    ? Object.freeze({ mode: 'resume', threadId: mode.threadId, options })
    : Object.freeze({ mode: 'start', options });
}

export function codexProcessEnvironment(
  executable: string,
  environment: Readonly<Record<string, string>>,
  pathExists: (path: string) => boolean = existsSync,
): Record<string, string> {
  const result = { ...environment };
  const tools = join(dirname(dirname(executable)), 'codex-path');
  if (pathExists(join(tools, 'rg'))) {
    result.PATH = [tools, result.PATH].filter(Boolean).join(delimiter);
  }
  return result;
}

function settings(input: ServerCoreProviderHostInput): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...input.settings,
  };
}

function createClient(
  options: CodexAppServerOptions,
  input: ServerCoreProviderHostInput,
): CodexAppServerClient {
  const logger = providerLogger(input.diagnostics, 'codex-app-server');
  return new CodexAppServerClient(options, {
    ...NOOP_CODEX_CLIENT_DIAGNOSTICS,
    generationDiagnostics: NOOP_CODEX_GENERATION_DIAGNOSTICS,
    createMcpStartupObserver: () => ({
      observe: () => null,
      reset: () => undefined,
    }),
    createThread: (client, mode, generation, runtime) =>
      new CodexAppServerThread(
        client,
        withServerCoreCodexWorkspaceBoundary(mode, input),
        generation,
        runtime,
      ),
    prepareThreadOptions: (_client, options) => Promise.resolve(options),
    startProcess: ({ codexPathOverride, cwd, env }) => {
      const executable = codexPathOverride?.trim() || HEADLESS_CODEX_EXECUTABLE;
      return spawn(
        executable,
        buildCodexWorkspaceAppServerArguments(frozenWorkspacePermissionBoundary(input)),
        {
          ...(cwd ? { cwd } : {}),
          env: codexProcessEnvironment(executable, env),
          stdio: 'pipe',
        },
      );
    },
    stderrActivity: (details) => logger.debug('stderr activity', details),
    stdoutParseFailed: (details) => logger.warn('stdout parse failed', details),
    notificationListenerFailed: (error) => logger.warn('listener failed', error),
  });
}

/** Concrete Codex value host for one Electron-free Server Core process. */
export function createServerCoreCodexHost(input: ServerCoreProviderHostInput) {
  const logger = providerLogger(input.diagnostics, 'codex-cli');
  const appSettings = settings(input);
  const clientHost: CodexClientConstructionHost = {
    createClient: (options) => createClient(options, input),
    readCodexCliPath: () => input.settings.codexCliPath ?? HEADLESS_CODEX_EXECUTABLE,
    readSettings: () => appSettings,
    readSkillExtraRoots: () => [],
    snapshotProcessEnv: () => providerProcessEnvironment(input),
  };

  return createCodexCliAdapterHost({
    bridge: {
      recoveryContinuationHost: unsupportedRecoveryHost(),
      runtimeHost: {
        sessions: input.repositories.sessionManager,
        tokens: mcpSessionTokenMap,
        records: {
          get: (sessionId) => input.repositories.sessions.get(sessionId),
          setCodexSandbox: (sessionId, value) =>
            input.repositories.sessions.setCodexSandbox(sessionId, value),
          setCodexApprovalPolicy: (sessionId, value) =>
            input.repositories.sessions.setCodexApprovalPolicy(sessionId, value),
          setRuntimeProvider: (sessionId, value) =>
            input.repositories.sessions.setRuntimeProvider(sessionId, value),
          setModel: (sessionId, value) => input.repositories.sessions.setModel(sessionId, value),
          setThinking: (sessionId, value) =>
            input.repositories.sessions.setThinking(sessionId, value),
          setExtraAllowWrite: (sessionId, value) =>
            input.repositories.sessions.setExtraAllowWrite(sessionId, value),
          setNetworkAccessEnabled: (sessionId, value) =>
            input.repositories.sessions.setNetworkAccessEnabled(sessionId, value),
          setAdditionalDirectories: (sessionId, value) =>
            input.repositories.sessions.setAdditionalDirectories(sessionId, value),
          publishUpdated: (sessionId) => publishProviderSession(input, sessionId),
        },
        configuration: {
          readApplicationInstructions: () => undefined,
          readConfiguredModel: () => null,
          readConfiguredReasoningEffort: () => null,
          readDefaultSandbox: () => input.settings.codexSandbox,
          validateModelProvider: (provider) => {
            resolveCodexModelProvider(provider);
          },
        },
        clientRegistry: {
          ensureClient: (options) => ensureCodexClientWithHost({
            ...options,
            hookServer: options.hookServer,
          }, clientHost),
          invalidateForPathChange: (clients, sessions) => {
            for (const [sessionId, client] of clients) {
              if (sessions.has(sessionId)) continue;
              client.dispose();
              clients.delete(sessionId);
            }
          },
          getUsageSnapshot: async () => unavailableUsageSnapshot(
            'codex-cli',
            'Server Core 未启用 Codex 额度探针',
          ),
          renameClient: (clients, oldId, newId) => {
            const client = clients.get(oldId);
            if (!client || clients.has(newId)) return;
            clients.delete(oldId);
            clients.set(newId, client);
          },
        },
        sessionModel: {
          read: (sessionId) => input.repositories.sessions.get(sessionId),
          setRuntimeProvider: (sessionId, value) =>
            input.repositories.sessions.setRuntimeProvider(sessionId, value),
          setModel: (sessionId, value) => input.repositories.sessions.setModel(sessionId, value),
          setThinking: (sessionId, value) =>
            input.repositories.sessions.setThinking(sessionId, value),
          publishUpdated: (sessionId) => publishProviderSession(input, sessionId),
          now: Date.now,
          info: (message) => logger.info(message),
          warn: (message, error) => logger.warn(message, error),
        },
        liveRate: {
          resolveModel: (applicationSid, sessionId) =>
            input.repositories.sessions.get(applicationSid)?.model ??
            input.repositories.sessions.get(sessionId)?.model ?? null,
          emitTokenRateTick: () => undefined,
        },
        logger: () => logger,
        observeIgnoredAppServerItemType: () => undefined,
        observeHeuristicStreamError: (message) => logger.warn(message),
        hasExactUserMessage: (sessionId, text) =>
          input.repositories.events.hasExactUserMessage(sessionId, text),
        guardHandOffSourceIngress: () => false,
        hasPendingWorktreeTransition: () => false,
        deleteUploadIfExists: async () => undefined,
        disposeSessionBrowser: async () => undefined,
      },
      createBridge: (options) => new CodexSdkBridge(options),
      readCodexCliPath: () => input.settings.codexCliPath ?? HEADLESS_CODEX_EXECUTABLE,
      readPermissionTimeoutMs: () => input.settings.permissionTimeoutMs,
    },
    hookRoutes: {
      filter: { shouldIgnore: async () => false },
      diagnostics: new HookRouteDiagnostics(),
      openToolUseReader: { listForSession: () => [] },
      observer: { reconciliationFailed: () => undefined },
    },
    hookInstallerObserver: { statusReadFailed: () => undefined },
    providerResolver: {
      resolveProvider: (provider) => resolveCodexModelProvider(provider)?.id,
    },
    summary: {
      readSummaryModel: () => input.settings.summaryModel,
      readSummaryReasoning: () => input.settings.summaryThinking,
      readSummaryTimeoutMs: () => input.settings.summaryTimeoutMs,
      runOneshot: async () => '',
      formatEvents: () => '',
    },
  });
}
