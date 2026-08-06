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
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
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
import {
  providerProcessEnvironment,
  providerLogger,
  publishProviderSession,
  type ServerCoreProviderHostInput,
} from './provider-host-common';
import { serverCoreClaudeWorkspacePolicy } from './provider-claude-sandbox';

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

/** Provider query boundary with no Browser, in-process MCP, or Electron path ownership. */
export function createServerCoreClaudeQueryHost(
  input: ServerCoreProviderHostInput,
): ClaudeCreateSessionSdkQueryHost {
  const logger = providerLogger(input.diagnostics, 'claude-sdk-query');
  const metadata = claudeRuntimeMetadataHost(input);
  const sandboxModes = new WeakMap<object, SandboxMode>();
  return {
    loadSdk: async () => {
      const sdk = await loadSdk();
      return { query: sdk.query };
    },
    runtimeOptions: () => ({
      executable: process.execPath as 'node',
      env: providerProcessEnvironment(input),
    }),
    resolveBinary: () => input.settings.claudeCliPath ?? HEADLESS_CLAUDE_EXECUTABLE,
    buildSandboxOptions: (mode) => {
      const effectiveMode: SandboxMode = mode ?? 'workspace-write';
      const result = serverCoreClaudeWorkspacePolicy(
        input.workspaceBoundary,
        effectiveMode,
      ).sandboxOptions;
      sandboxModes.set(result, effectiveMode);
      return result;
    },
    prepareGatewaySandboxSettings: (candidate) => {
      const result = prepareGatewaySandboxSettingsCore(candidate, derivedSettingsHost(input));
      sandboxModes.set(
        result.sandboxOpts,
        sandboxModes.get(candidate.sandboxOpts) ?? 'workspace-write',
      );
      return result;
    },
    buildMcpServers: async () => ({ agentDeckMcpServer: null }),
    buildQueryOptions: (args) => {
      const policy = serverCoreClaudeWorkspacePolicy(
        input.workspaceBoundary,
        sandboxModes.get(args.sandboxOpts) ?? 'workspace-write',
      );
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
    systemPromptAppend: () => '',
    plugins: () => [],
    runtimeMetadataHooks: (internal) => runtimeHooks(internal, metadata),
    cleanupGatewaySandboxSettings: cleanupGatewaySandboxSettingsCore,
    observeSandboxConfiguration: (message) => logger.info(message),
    warn: (message, error) => logger.warn(message, error),
  };
}
