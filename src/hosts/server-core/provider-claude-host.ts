import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createClaudeCodeAdapterHost } from '@main/adapters/claude-code/aggregate-host-core';
import {
  assertClaudeGatewayForkTranscriptRootCompatibleCore,
} from '@main/adapters/claude-code/gateway-fork-safety-core';
import {
  resolveClaudeGatewayProfileCore,
  type ClaudeGatewayProfileHost,
} from '@main/adapters/claude-code/gateway-profiles-core';
import {
  encodeClaudeSdkProjectKey,
  getClaudeConfigRoot,
} from '@main/adapters/claude-code/fork-session-core';
import { createClaudeSessionManagerPort } from '@main/adapters/claude-code/session-manager-core';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { rememberIgnoredClaudeUserMessageIdCore } from '@main/adapters/claude-code/sdk-bridge/user-message-acceptance-core';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import {
  HEADLESS_CLAUDE_EXECUTABLE,
  createServerCoreClaudeQueryHost,
} from './provider-claude-query-host';
import {
  createServerCoreClaudeLifecycleHost,
  createServerCoreClaudeStreamHost,
} from './provider-claude-stream-host';
import {
  providerProcessEnvironment,
  providerLogger,
  publishProviderSession,
  unsupportedRecoveryHost,
  type ServerCoreProviderHostInput,
} from './provider-host-common';

function gatewayHost(): ClaudeGatewayProfileHost {
  return {
    joinPath: join,
    listDirectory: (directory) => readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
    isFile: (path) => statSync(path).isFile(),
    pathExists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

function gatewayProfile(gatewaysDir: string, gateway?: string | null) {
  return resolveClaudeGatewayProfileCore(
    gateway,
    { gatewaysDir },
    gatewayHost(),
  );
}

function canonical(path: string): string {
  try {
    return normalize(realpathSync(resolve(path))).normalize('NFC');
  } catch {
    return normalize(resolve(path)).normalize('NFC');
  }
}

/** Concrete Claude value host for one Electron-free Server Core process. */
export function createServerCoreClaudeHost(input: ServerCoreProviderHostInput) {
  const logger = providerLogger(input.diagnostics, 'claude-code');
  const sessionManager = createClaudeSessionManagerPort(input.repositories.sessionManager);
  const queryHost = createServerCoreClaudeQueryHost(input);
  const recovery = unsupportedRecoveryHost();
  const providerEnvironment = providerProcessEnvironment(input);
  const configRoot = getClaudeConfigRoot(providerEnvironment);
  const gatewaysDir = join(configRoot, 'gateways');

  return createClaudeCodeAdapterHost({
    bridge: {
      createSessionHost: {
        readPersistedSession: (sessionId) => input.repositories.sessions.get(sessionId),
        readSandboxDefault: () => input.settings.claudeCodeSandbox,
        resolveGatewayProfile: (gateway) => gatewayProfile(gatewaysDir, gateway),
        deleteTransientSession: (sessionId) => input.repositories.sessions.delete(sessionId),
      },
      jsonlDiscoveryHost: {
        transcriptPath: (cwd, sessionId) => join(
          configRoot,
          'projects',
          encodeClaudeSdkProjectKey(cwd),
          `${sessionId}.jsonl`,
        ),
        pathExists: existsSync,
        pathMtimeMs: (path) => statSync(path).mtimeMs,
      },
      recoveryFreshnessHost: {
        ...recovery,
        latestConversationMessageTs: (sessionId) =>
          input.repositories.events.latestConversationMessageTs(sessionId),
        warn: (message, error) => logger.warn(message, error),
      },
      restartSessionHost: {
        readSession: (sessionId) => input.repositories.sessions.get(sessionId),
        setPermissionModeAndPublish: (sessionId, mode) => {
          input.repositories.sessions.setPermissionMode(sessionId, mode);
          publishProviderSession(input, sessionId);
        },
        setSandboxAndPublish: (sessionId, sandbox) => {
          input.repositories.sessions.setClaudeCodeSandbox(sessionId, sandbox);
          publishProviderSession(input, sessionId);
        },
        subscribeRenames: (listener) => input.renames.subscribe(listener),
        warn: (message, error) => logger.warn(message, error),
      },
      sessionModelHost: {
        read: (sessionId) => input.repositories.sessions.get(sessionId),
        setRuntimeProvider: (sessionId, provider) =>
          input.repositories.sessions.setRuntimeProvider(sessionId, provider),
        setModel: (sessionId, model) => input.repositories.sessions.setModel(sessionId, model),
        setThinking: (sessionId, thinking) =>
          input.repositories.sessions.setThinking(sessionId, thinking),
        publishUpdated: (sessionId) => publishProviderSession(input, sessionId),
        now: Date.now,
        info: (message) => logger.info(message),
        warn: (message, error) => logger.warn(message, error),
      },
      usageSnapshotHost: {
        loadSdk: async () => {
          const sdk = await loadSdk();
          return { query: sdk.query };
        },
        getRuntimeOptions: () => ({
          executable: process.execPath as 'node',
          env: { ...providerEnvironment },
        }),
        resolveClaudeBinary: () =>
          input.settings.claudeCliPath ?? HEADLESS_CLAUDE_EXECUTABLE,
        getProbeCwd: () => input.workspaceBoundary.providerTempRoot,
        expectSdkSession: (cwd, ttlMs) => sessionManager.expectSdkSession(cwd, ttlMs),
        now: Date.now,
      },
      permissionResponderHost: {
        persistPermissionMode: (sessionId, mode) => {
          input.repositories.sessions.setPermissionMode(sessionId, mode);
          publishProviderSession(input, sessionId);
        },
        observeHotSwitchFailure: (_sessionId, error) =>
          logger.warn('permission hot switch failed', error),
        observeColdSwitchFailure: (_sessionId, error) =>
          logger.warn('permission cold switch failed', error),
        now: Date.now,
      },
      cwdTransitionHost: {
        getSession: (sessionId) => input.repositories.sessions.get(sessionId),
      },
      messageControllerHost: {
        guardSourceIngress: (args) => input.worktrees.guardIngress({
          sourceSessionId: args.sourceSessionId,
          agentId: 'claude-code',
          text: args.text,
          attachments: args.attachments,
          emit: args.emit,
          bypassWorktreeTransition: args.bypassWorktreeTransition,
        }),
        acceptedEnqueueEventFailed: (_key, error) =>
          logger.warn('accepted enqueue event failed', error),
        now: Date.now,
      },
      sessionLifecycleHost: createServerCoreClaudeLifecycleHost(input, sessionManager),
      pendingOutgoingHost: {
        rememberIgnoredUserMessageId: rememberIgnoredClaudeUserMessageIdCore,
      },
      streamProcessorHost: createServerCoreClaudeStreamHost(input, sessionManager),
      sessionFinalizeHost: {
        now: Date.now,
        updateCliSessionId: (applicationSid, cliSessionId) =>
          sessionManager.updateCliSessionId(applicationSid, cliSessionId),
        setSandbox: (sessionId, mode) =>
          input.repositories.sessions.setClaudeCodeSandbox(sessionId, mode),
        setRuntimeProvider: (sessionId, provider) =>
          input.repositories.sessions.setRuntimeProvider(sessionId, provider),
        setAgentRuntimeProfile: (sessionId, profile) =>
          input.repositories.sessions.setAgentRuntimeProfile(sessionId, profile),
        setModel: (sessionId, model) => input.repositories.sessions.setModel(sessionId, model),
        setThinking: (sessionId, thinking) =>
          input.repositories.sessions.setThinking(sessionId, thinking),
        setExtraAllowWrite: (sessionId, paths) =>
          input.repositories.sessions.setExtraAllowWrite(sessionId, paths),
        publishPersistedSession: (sessionId) => publishProviderSession(input, sessionId),
        warn: (message, error) => logger.warn(message, error),
      },
      canUseToolHost: {
        createRequestId: randomUUID,
        now: Date.now,
        observeSandboxIntercept: (host) => logger.info(`sandbox blocked host ${host}`),
      },
      createSessionSdkQueryHost: queryHost,
      sessionManager,
      createBridge: (options) => new ClaudeSdkBridge(options),
      readPermissionTimeoutMs: () => input.settings.permissionTimeoutMs,
    },
    fork: {
      loadSdk: async () => loadSdk(),
      readConfigRoot: () => configRoot,
      childSessionStore: {
        get: (sessionId) => input.repositories.sessions.get(sessionId),
        delete: (sessionId) => input.repositories.sessions.delete(sessionId),
      },
      cleanupObserver: {
        recordIssue: ({ phase, error }) => logger.warn(`fork cleanup ${phase} failed`, error),
      },
    },
    hookDiagnostics: new HookRouteDiagnostics(),
    hookInstallerObserver: { statusReadFailed: () => undefined },
    forkSafety: {
      validateForkTarget: (gateway) => assertClaudeGatewayForkTranscriptRootCompatibleCore(
        gateway,
        { gatewaysDir },
        providerEnvironment,
        {
          getMainConfigRoot: () => configRoot,
          resolveGatewayProfile: (candidate) => gatewayProfile(gatewaysDir, candidate),
          canonicalizeConfigRoot: canonical,
        },
      ),
    },
    summary: {
      summariseEvents: async () => null,
    },
  });
}
