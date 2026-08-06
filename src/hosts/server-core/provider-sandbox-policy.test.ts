import { describe, expect, it } from 'vitest';

import { createServerCoreClaudeQueryHost } from './provider-claude-query-host';
import { serverCoreClaudeWorkspacePolicy } from './provider-claude-sandbox';
import { serverCoreGrokSandbox } from './provider-grok-sandbox';
import type { ServerCoreProviderWorkspaceBoundary } from './provider-host-common';
import { applyServerCoreRuntimePatch } from './runtime-controls';

const boundary: ServerCoreProviderWorkspaceBoundary = Object.freeze({
  workspaceRoot: '/srv/worker/workspace',
  privateRoot: '/srv/worker/private',
  providerHomeRoot: '/srv/worker/private/provider-home',
  runtimeReadRoots: Object.freeze(['/opt/agent-deck']),
  providerCacheRoot: '/srv/worker/private/provider-cache',
  providerTempRoot: '/srv/worker/private/provider-tmp',
});

describe('Server Core provider Workspace policies', () => {
  it('maps Claude off to full Workspace access while hiding Worker-private state', () => {
    const policy = serverCoreClaudeWorkspacePolicy(boundary, 'off');

    expect(policy.sandboxOptions.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [boundary.workspaceRoot],
        denyRead: ['/'],
        allowRead: [boundary.workspaceRoot, '/opt/agent-deck'],
        denyWrite: [boundary.privateRoot, boundary.providerHomeRoot],
      },
    });
    expect(policy.managedSettings).toMatchObject({
      sandbox: { filesystem: { allowManagedReadPathsOnly: true } },
    });
    expect(policy.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('lets workspace-write and strict narrow Claude without disabling native customization', () => {
    const workspace = serverCoreClaudeWorkspacePolicy(boundary, 'workspace-write');
    const sandbox = serverCoreClaudeWorkspacePolicy(boundary, 'strict').sandboxOptions.sandbox;

    expect(workspace.sandboxOptions.sandbox?.filesystem?.allowWrite)
      .toEqual([boundary.workspaceRoot]);
    expect(workspace.managedSettings).not.toHaveProperty('allowManagedHooksOnly');
    expect(workspace.managedSettings).not.toHaveProperty('allowManagedMcpServersOnly');
    expect(workspace.managedSettings).not.toHaveProperty('strictPluginOnlyCustomization');
    expect(workspace.settingSources).toEqual(['user', 'project', 'local']);
    expect(sandbox?.filesystem?.allowWrite).toEqual([]);
    expect(sandbox?.filesystem?.allowRead).not.toContain(boundary.privateRoot);
    expect(sandbox?.filesystem?.allowRead).not.toContain(boundary.providerHomeRoot);
  });

  it('installs the Claude ceiling after ordinary query options are composed', () => {
    const host = createServerCoreClaudeQueryHost({
      workspaceBoundary: boundary,
      diagnostics: { info: () => undefined, warn: () => undefined },
      paths: { stateDirectory: '/tmp/unused-server-core-state' },
      settings: { claudeCliPath: null },
    } as never);
    const sandboxOpts = host.buildSandboxOptions(
      'workspace-write',
      boundary.workspaceRoot,
      ['/outside'],
    );
    const options = host.buildQueryOptions({
      cwd: boundary.workspaceRoot,
      canUseTool: async () => ({ behavior: 'deny', message: 'denied' }),
      sandboxOpts,
      systemPromptAppend: '',
      plugins: [{ type: 'local', path: '/outside/plugin' }],
      runtime: { executable: 'node', env: {} },
      claudeBinary: '/opt/agent-deck/claude',
      mcpServers: { agentDeckMcpServer: null },
      permissionMode: 'bypassPermissions',
    });

    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.plugins).toEqual([{ type: 'local', path: '/outside/plugin' }]);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.sandbox).toEqual(sandboxOpts.sandbox);
    expect(options.managedSettings).not.toHaveProperty('allowedMcpServers');
    expect(options.managedSettings).not.toHaveProperty('permissions');
    expect(options.managedSettings).toMatchObject({
      sandbox: { filesystem: { allowManagedReadPathsOnly: true } },
    });
  });

  it('keeps Grok fail-closed until private-state-denying profile wrappers are installed', () => {
    for (const requested of [null, 'off', 'workspace', 'read-only', 'devbox', 'custom']) {
      expect(serverCoreGrokSandbox(requested)).toBe('strict');
    }
  });

  it('clamps a live remote Grok sandbox restart before it reaches the adapter', async () => {
    const requested: Array<string | null> = [];
    const result = await applyServerCoreRuntimePatch({
      restartWithGrokSandbox: async (_sessionId, sandbox) => {
        requested.push(sandbox);
        return 'replacement-session';
      },
    } as never, {
      id: 'session-a',
      agentId: 'grok-build',
    } as never, { grokSandbox: 'off' });

    expect(requested).toEqual(['strict']);
    expect(result).toEqual({
      effect: 'restart-required',
      replacementSessionId: 'replacement-session',
    });
  });
});
