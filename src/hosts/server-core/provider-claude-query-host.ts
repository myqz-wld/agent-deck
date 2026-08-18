import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxMode } from '@main/adapters/claude-code/sandbox-config-core';
import {
  cleanupGatewaySandboxSettingsCore,
  prepareGatewaySandboxSettingsCore,
} from '@main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core';
import type { ClaudeCreateSessionSdkQueryHost } from '@main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-core';
import { buildClaudeQueryOptionsCore } from '@main/adapters/claude-code/sdk-bridge/query-options-builder-core';
import {
  syncClaudeRuntimeEffortCore,
  warnClaudeRuntimeMetadataWithoutThrow,
  type ClaudeRuntimeMetadataHost,
} from '@main/adapters/claude-code/sdk-bridge/runtime-metadata-core';
import type { InternalSession } from '@main/adapters/claude-code/sdk-bridge/types';
import { buildMcpServersWithHost } from '@main/adapters/claude-code/sdk-bridge/mcp-server-core';
import {
  providerProcessEnvironment,
  providerLogger,
  publishProviderSession,
  type ServerCoreProviderHostInput,
} from './provider-host-common';
import { loadServerCoreClaudeSdk } from './provider-claude-sdk';
import { serverCoreClaudeWorkspacePolicy } from './provider-claude-sandbox';
import {
  assertServerCoreAdditionalWriteRoots,
  assertServerCoreProviderSandboxScope,
} from './provider-sandbox-policy';

export const HEADLESS_CLAUDE_EXECUTABLE = '/opt/agent-deck/providers/claude/claude';

export function claudeRuntimeMetadataHost(
  input: ServerCoreProviderHostInput,
): ClaudeRuntimeMetadataHost {
  const logger = providerLogger(input.diagnostics, 'claude-runtime-metadata');
  return {
    read: (sessionId) => input.repositories.sessions.get(sessionId),
    setModel: (sessionId, model) => input.repositories.sessions.setModel(sessionId, model),
    setEffort: (sessionId, effort) =>
      input.repositories.sessions.setThinking(sessionId, effort),
    emitUpdated: (sessionId) => publishProviderSession(input, sessionId),
    warnFailure: (kind, _sessionId, error) => logger.warn(`${kind} sync failed`, error),
  };
}

function runtimeHooks(
  internal: InternalSession,
  metadata: ClaudeRuntimeMetadataHost,
): ReturnType<ClaudeCreateSessionSdkQueryHost['runtimeMetadataHooks']> {
  const captureEffort: HookCallback = async (hookInput) => {
    try {
      if (
        hookInput.agent_id === undefined &&
        (hookInput.hook_event_name === 'Stop' || hookInput.hook_event_name === 'StopFailure')
      ) {
        syncClaudeRuntimeEffortCore(internal, hookInput.effort?.level, metadata);
      }
    } catch (error) {
      warnClaudeRuntimeMetadataWithoutThrow(
        metadata,
        'hook',
        internal.applicationSid,
        error,
      );
    }
    return {};
  };
  return {
    Stop: [{ hooks: [captureEffort] }],
    StopFailure: [{ hooks: [captureEffort] }],
  };
}

function derivedSettingsHost(input: ServerCoreProviderHostInput) {
  return {
    readSettingsText: (path: string) => readFileSync(path, 'utf8'),
    materializeDerivedSettings: (serializedSettings: string) => {
      mkdirSync(input.paths.stateDirectory, { recursive: true, mode: 0o700 });
      const directory = mkdtempSync(join(input.paths.stateDirectory, 'claude-gateway-'));
      const settingsPath = join(directory, `${randomUUID()}.json`);
      writeFileSync(settingsPath, serializedSettings, { encoding: 'utf8', mode: 0o600 });
      return {
        settingsPath,
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
      };
    },
  };
}

/** Provider query boundary with a Core-owned in-process MCP server and no Electron ownership. */
export function createServerCoreClaudeQueryHost(
  input: ServerCoreProviderHostInput,
): ClaudeCreateSessionSdkQueryHost {
  const logger = providerLogger(input.diagnostics, 'claude-sdk-query');
  const metadata = claudeRuntimeMetadataHost(input);
  const sandboxContexts = new WeakMap<object, { cwd: string; mode: SandboxMode }>();
  return {
    loadSdk: async () => {
      const sdk = await loadServerCoreClaudeSdk();
      return { query: sdk.query };
    },
    runtimeOptions: () => ({
      executable: process.execPath as 'node',
      env: providerProcessEnvironment(input),
    }),
    prepareBrowserRuntime: (applicationSessionId, environment) =>
      input.browserRuntime.prepare({
        applicationSessionId,
        adapterId: 'claude-code',
        environment,
      }),
    revokeBrowserRuntime: (applicationSessionId) => {
      input.browserRuntime.revokeSession(applicationSessionId);
    },
    allowBrowserSocket: (sandboxOptions) =>
      input.browserRuntime.allowClaudeSocket(sandboxOptions),
    resolveBinary: () => input.settings.claudeCliPath ?? HEADLESS_CLAUDE_EXECUTABLE,
    buildSandboxOptions: (mode, cwd, extraAllowWrite) => {
      const effectiveMode: SandboxMode = mode ?? 'workspace-write';
      const policy = serverCoreClaudeWorkspacePolicy(
        input.workspaceBoundary,
        effectiveMode,
        cwd,
      );
      assertServerCoreAdditionalWriteRoots(policy.effectivePolicy, extraAllowWrite);
      sandboxContexts.set(policy.sandboxOptions, {
        cwd: policy.effectivePolicy.scope.selectedDirectory,
        mode: effectiveMode,
      });
      return policy.sandboxOptions;
    },
    prepareGatewaySandboxSettings: (candidate) => {
      const result = prepareGatewaySandboxSettingsCore(candidate, derivedSettingsHost(input));
      const context = sandboxContexts.get(candidate.sandboxOpts);
      if (!context) throw new Error('Claude sandbox context is unavailable');
      sandboxContexts.set(result.sandboxOpts, context);
      return result;
    },
    buildMcpServers: (internal, adapterId) => buildMcpServersWithHost({
      createServer: (callerSessionId, authenticatedAdapterId) =>
        input.mcpBroker.createInProcessServer(callerSessionId, authenticatedAdapterId),
      onServerAttached: () => undefined,
      readEnabled: () => input.settings.enableAgentDeckMcp && input.mcpBroker.isRunning,
    }, internal, adapterId),
    buildQueryOptions: (args) => {
      const context = sandboxContexts.get(args.sandboxOpts);
      if (!context || args.cwd !== context.cwd) {
        throw new Error('Claude query directory does not match its sandbox context');
      }
      const policy = serverCoreClaudeWorkspacePolicy(
        input.workspaceBoundary,
        context.mode,
        context.cwd,
      );
      assertServerCoreProviderSandboxScope(policy.effectivePolicy.scope);
      const options = buildClaudeQueryOptionsCore({
        ...args,
        agentDeckMcpToolPattern: 'mcp__agent-deck__*',
      });
      return {
        ...options,
        managedSettings: policy.managedSettings,
        settingSources: policy.settingSources,
      };
    },
    systemPromptAppend: () => input.settings.injectAgentDeckClaudeMd
      ? input.assets.applicationInstructions('claude-code')
      : '',
    plugins: () => input.assets.claudePlugins(),
    runtimeMetadataHooks: (internal) => runtimeHooks(internal, metadata),
    cleanupGatewaySandboxSettings: cleanupGatewaySandboxSettingsCore,
    observeSandboxConfiguration: (message) => logger.info(message),
    warn: (message, error) => logger.warn(message, error),
  };
}
