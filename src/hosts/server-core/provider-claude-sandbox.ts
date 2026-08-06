import type {
  Options,
  SandboxSettings,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import type { SandboxMode } from '@main/adapters/claude-code/sandbox-config-core';

import type { ServerCoreProviderWorkspaceBoundary } from './provider-host-common';

export interface ServerCoreClaudeWorkspacePolicy {
  readonly sandboxOptions: Pick<Options, 'sandbox'>;
  readonly managedSettings: Settings;
  readonly settingSources: NonNullable<Options['settingSources']>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sandboxSettings(
  boundary: ServerCoreProviderWorkspaceBoundary,
  mode: SandboxMode | undefined,
): SandboxSettings {
  const workspaceWrite = mode !== 'strict';
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      allowWrite: workspaceWrite ? [boundary.workspaceRoot] : [],
      denyWrite: unique([boundary.privateRoot, boundary.providerHomeRoot]),
      // Commands need the provider runtime binaries, but no host data root is readable. The
      // Workspace carve-out takes precedence over this root denial in Claude's sandbox runtime.
      denyRead: ['/'],
      allowRead: unique([boundary.workspaceRoot, ...boundary.runtimeReadRoots]),
    },
  };
}

/**
 * Provider-native child policy shared by Desktop and Feishu sessions. `off` means no narrowing
 * beyond the Workspace ceiling, but the child policy still hides Worker/provider private state
 * that the outer Worker process itself must be able to read. Project hooks, MCP servers, plugins,
 * and permission rules remain enabled and their subprocesses inherit the same ceiling.
 */
export function serverCoreClaudeWorkspacePolicy(
  boundary: ServerCoreProviderWorkspaceBoundary,
  mode: SandboxMode | undefined,
): ServerCoreClaudeWorkspacePolicy {
  const settingSources = ['user', 'project', 'local'] as NonNullable<Options['settingSources']>;
  const sandbox = sandboxSettings(boundary, mode);
  const managedSandbox: SandboxSettings = {
    ...sandbox,
    filesystem: {
      ...sandbox.filesystem,
      allowManagedReadPathsOnly: true,
    },
  };
  return Object.freeze({
    sandboxOptions: Object.freeze({ sandbox }),
    managedSettings: Object.freeze({
      sandbox: managedSandbox,
    }),
    settingSources,
  });
}
