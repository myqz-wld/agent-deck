import type {
  Options,
  SandboxSettings,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import type { SandboxMode } from '@main/adapters/claude-code/sandbox-config-core';

import type { ServerCoreProviderWorkspaceBoundary } from './provider-host-common';
import {
  compileServerCoreProviderSandboxPolicy,
  type ServerCoreEffectiveProviderSandboxPolicy,
} from './provider-sandbox-policy';

export interface ServerCoreClaudeWorkspacePolicy {
  readonly effectivePolicy: ServerCoreEffectiveProviderSandboxPolicy;
  readonly sandboxOptions: Pick<Options, 'sandbox'>;
  readonly managedSettings: Settings;
  readonly settingSources: NonNullable<Options['settingSources']>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sandboxSettings(
  policy: ServerCoreEffectiveProviderSandboxPolicy,
): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      allowWrite: [...policy.readWriteRoots],
      denyWrite: [...policy.modelDeniedRoots],
      // Commands need the provider runtime binaries, but no host data root is readable. The
      // Workspace carve-out takes precedence over this root denial in Claude's sandbox runtime.
      denyRead: ['/'],
      allowRead: unique(policy.readOnlyRoots),
    },
  };
}

/**
 * Provider-native child policy shared by Desktop and Feishu sessions. `off` means no narrowing
 * beyond the Workspace ceiling, but the child policy still hides Worker/provider private state
 * that the outer Worker process itself must be able to read. Only the Core-owned `agent-deck`
 * in-process MCP server is admitted; unmanaged hooks, MCP servers, plugin marketplaces, and skill
 * shell snippets remain disabled so no auxiliary child can bypass the filesystem policy.
 */
export function serverCoreClaudeWorkspacePolicy(
  boundary: ServerCoreProviderWorkspaceBoundary,
  mode: SandboxMode | undefined,
  workingDirectory: string,
): ServerCoreClaudeWorkspacePolicy {
  const settingSources = ['user', 'project', 'local'] as NonNullable<Options['settingSources']>;
  const effectivePolicy = compileServerCoreProviderSandboxPolicy(boundary, {
    adapterId: 'claude-code',
    mode: mode ?? 'workspace-write',
  }, workingDirectory);
  const sandbox = sandboxSettings(effectivePolicy);
  const managedSandbox: SandboxSettings = {
    ...sandbox,
    filesystem: {
      ...sandbox.filesystem,
      allowManagedReadPathsOnly: true,
    },
  };
  const managedSettings: Settings = {
    allowManagedHooksOnly: true,
    allowManagedMcpServersOnly: true,
    allowedHttpHookUrls: [],
    allowedMcpServers: [{ serverName: 'agent-deck' }],
    disableSideloadFlags: true,
    disableSkillShellExecution: true,
    sandbox: managedSandbox,
    strictKnownMarketplaces: [],
    strictPluginOnlyCustomization: ['hooks', 'mcp'],
  };
  return Object.freeze({
    effectivePolicy,
    sandboxOptions: Object.freeze({ sandbox }),
    managedSettings: Object.freeze(managedSettings),
    settingSources,
  });
}
