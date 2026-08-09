import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createServerCoreClaudeQueryHost } from './provider-claude-query-host';
import { serverCoreClaudeWorkspacePolicy } from './provider-claude-sandbox';
import { serverCoreGrokSandbox } from './provider-grok-sandbox';
import {
  providerProcessEnvironment,
  type ServerCoreProviderWorkspaceBoundary,
} from './provider-host-common';
import {
  assertServerCoreAdditionalWriteRoots,
  assertServerCoreProviderSandboxScope,
  compileServerCoreProviderSandboxPolicy,
  serverCoreProviderSandboxChoices,
} from './provider-sandbox-policy';
import { applyServerCoreRuntimePatch } from './runtime-controls';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function harness(): {
  boundary: ServerCoreProviderWorkspaceBoundary;
  root: string;
  selected: string;
  sibling: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-core-provider-policy-')));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const selected = join(workspaceRoot, 'project-a');
  const sibling = join(workspaceRoot, 'project-b');
  const privateRoot = join(root, 'private');
  const providerHomeRoot = join(privateRoot, 'provider-home');
  const providerCacheRoot = join(privateRoot, 'provider-cache');
  const providerTempRoot = join(privateRoot, 'provider-tmp');
  const runtimeRoot = join(root, 'runtime');
  for (const path of [
    selected,
    sibling,
    providerHomeRoot,
    providerCacheRoot,
    providerTempRoot,
    runtimeRoot,
  ]) mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(privateRoot, 0o700);
  return {
    root,
    selected,
    sibling,
    boundary: Object.freeze({
      workspaceRoot,
      privateRoot,
      providerHomeRoot,
      runtimeReadRoots: Object.freeze([runtimeRoot]),
      providerCacheRoot,
      providerTempRoot,
    }),
  };
}

describe('Server Core provider Workspace policies', () => {
  it('maps Claude modes to Workspace or selected-directory roots only', () => {
    const { boundary, selected } = harness();
    const broad = serverCoreClaudeWorkspacePolicy(boundary, 'off', selected);
    const selectedWrite = serverCoreClaudeWorkspacePolicy(
      boundary,
      'workspace-write',
      selected,
    );
    const strict = serverCoreClaudeWorkspacePolicy(boundary, 'strict', selected);

    expect(broad.sandboxOptions.sandbox?.filesystem).toMatchObject({
      allowWrite: [boundary.workspaceRoot],
      allowRead: [boundary.runtimeReadRoots[0], boundary.workspaceRoot],
      denyRead: ['/'],
    });
    expect(selectedWrite.sandboxOptions.sandbox?.filesystem).toMatchObject({
      allowWrite: [selected],
      allowRead: [boundary.runtimeReadRoots[0], boundary.workspaceRoot],
    });
    expect(strict.sandboxOptions.sandbox?.filesystem).toMatchObject({
      allowWrite: [],
      allowRead: [boundary.runtimeReadRoots[0], selected],
    });
    for (const policy of [broad, selectedWrite, strict]) {
      expect(policy.sandboxOptions.sandbox?.filesystem?.denyWrite).toEqual([
        boundary.privateRoot,
        boundary.providerHomeRoot,
        boundary.providerCacheRoot,
        boundary.providerTempRoot,
      ]);
      expect(policy.managedSettings).toMatchObject({
        allowManagedHooksOnly: true,
        allowManagedMcpServersOnly: true,
        allowedHttpHookUrls: [],
        allowedMcpServers: [{ serverName: 'agent-deck' }],
        disableSideloadFlags: true,
        disableSkillShellExecution: true,
        strictKnownMarketplaces: [],
        strictPluginOnlyCustomization: ['hooks', 'mcp'],
        sandbox: { filesystem: { allowManagedReadPathsOnly: true } },
      });
      expect(policy.settingSources).toEqual(['user', 'project', 'local']);
    }
  });

  it('revalidates Claude roots after query options are composed', () => {
    const { boundary, root, selected, sibling } = harness();
    const stateDirectory = join(root, 'state');
    mkdirSync(stateDirectory, { mode: 0o700 });
    const host = createServerCoreClaudeQueryHost({
      workspaceBoundary: boundary,
      diagnostics: { info: () => undefined, warn: () => undefined },
      paths: { stateDirectory },
      settings: { claudeCliPath: null },
    } as never);
    expect(() => host.buildSandboxOptions('workspace-write', selected, [sibling]))
      .toThrow('additional write roots');
    const sandboxOpts = host.buildSandboxOptions('workspace-write', selected, []);
    const options = host.buildQueryOptions({
      cwd: selected,
      canUseTool: async () => ({ behavior: 'deny', message: 'denied' }),
      sandboxOpts,
      systemPromptAppend: '',
      plugins: [],
      runtime: { executable: 'node', env: {} },
      claudeBinary: '/opt/agent-deck/claude',
      mcpServers: { agentDeckMcpServer: null },
      permissionMode: 'bypassPermissions',
    });

    expect(options.sandbox).toEqual(sandboxOpts.sandbox);
    expect(options.managedSettings).toMatchObject({
      allowManagedHooksOnly: true,
      allowManagedMcpServersOnly: true,
    });
    expect(() => host.buildQueryOptions({
      cwd: sibling,
      canUseTool: async () => ({ behavior: 'deny', message: 'denied' }),
      sandboxOpts,
      systemPromptAppend: '',
      plugins: [],
      runtime: { executable: 'node', env: {} },
      claudeBinary: '/opt/agent-deck/claude',
      mcpServers: { agentDeckMcpServer: null },
      permissionMode: 'bypassPermissions',
    })).toThrow('does not match its sandbox context');
  });

  it('accepts only fixed Grok profiles with a container access mapping', () => {
    for (const requested of ['strict', 'off', 'workspace', 'read-only'] as const) {
      expect(serverCoreGrokSandbox(requested)).toBe(requested);
    }
    for (const requested of [null, undefined, 'custom', 'devbox']) {
      expect(() => serverCoreGrokSandbox(requested)).toThrow('unavailable');
    }
  });

  it('fails closed on path escapes, private-state exposure, and identity replacement', () => {
    const { boundary, root, selected, sibling } = harness();
    const outside = join(root, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(boundary.workspaceRoot, 'escape'));
    expect(() => compileServerCoreProviderSandboxPolicy(boundary, {
      adapterId: 'codex-cli',
      mode: 'workspace-write',
    }, join(boundary.workspaceRoot, 'escape'))).toThrow('canonical');

    chmodSync(boundary.providerHomeRoot, 0o755);
    expect(() => compileServerCoreProviderSandboxPolicy(boundary, {
      adapterId: 'claude-code',
      mode: 'strict',
    }, selected)).toThrow('process-private');
    chmodSync(boundary.providerHomeRoot, 0o700);

    const policy = compileServerCoreProviderSandboxPolicy(boundary, {
      adapterId: 'codex-cli',
      mode: 'workspace-write',
    }, selected);
    expect(() => assertServerCoreAdditionalWriteRoots(policy, [sibling]))
      .toThrow('additional write roots');
    renameSync(selected, `${selected}-old`);
    mkdirSync(selected, { mode: 0o700 });
    expect(() => assertServerCoreProviderSandboxScope(policy.scope))
      .toThrow('identity changed');
  });

  it('publishes sandbox choices from the same compiler vocabulary', () => {
    expect(serverCoreProviderSandboxChoices('claude-code')).toEqual([
      expect.objectContaining({ value: 'off', effectiveAccess: 'workspace-read-write' }),
      expect.objectContaining({
        value: 'workspace-write',
        effectiveAccess: 'selected-directory-read-write',
      }),
      expect.objectContaining({ value: 'strict', effectiveAccess: 'provider-strict' }),
    ]);
    expect(serverCoreProviderSandboxChoices('grok-build')).toEqual([
      expect.objectContaining({
        value: 'read-only',
        enabled: false,
        effectiveAccess: 'workspace-read-only',
      }),
      expect.objectContaining({
        value: 'workspace',
        enabled: false,
        effectiveAccess: 'selected-directory-read-write',
      }),
      expect.objectContaining({
        value: 'off',
        enabled: false,
        effectiveAccess: 'workspace-read-write',
      }),
    ]);
    expect(serverCoreProviderSandboxChoices('grok-build', true)).toEqual([
      expect.objectContaining({ value: 'read-only', enabled: true, disabledReason: null }),
      expect.objectContaining({ value: 'workspace', enabled: true, disabledReason: null }),
      expect.objectContaining({ value: 'off', enabled: true, disabledReason: null }),
    ]);
  });

  it('pins provider state and allowlists only non-secret inherited runtime values', () => {
    const { boundary } = harness();
    const environment = providerProcessEnvironment({ workspaceBoundary: boundary }, {
      PATH: '/usr/bin:/bin',
      ANTHROPIC_API_KEY: 'provider-owned',
      AGENT_DECK_MCP_TOKEN: 'ambient-session-token',
      AWS_SESSION_TOKEN: 'ambient-cloud-token',
      SSH_AUTH_SOCK: '/tmp/ambient-agent.sock',
      BASH_ENV: '/tmp/injected',
      DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
      LD_PRELOAD: '/tmp/injected.so',
      NODE_OPTIONS: '--require=/tmp/injected.js',
      NODE_PATH: '/tmp/injected-modules',
    });

    expect(environment).toMatchObject({
      HOME: boundary.providerHomeRoot,
      CLAUDE_CONFIG_DIR: join(boundary.providerHomeRoot, '.claude'),
      CODEX_HOME: join(boundary.providerHomeRoot, '.codex'),
      GROK_HOME: join(boundary.providerHomeRoot, '.grok'),
      XDG_CACHE_HOME: boundary.providerCacheRoot,
      TMPDIR: boundary.providerTempRoot,
      PATH: '/usr/bin:/bin',
    });
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment).not.toHaveProperty('AGENT_DECK_MCP_TOKEN');
    expect(environment).not.toHaveProperty('AWS_SESSION_TOKEN');
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(environment).not.toHaveProperty('BASH_ENV');
    expect(environment).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(environment).not.toHaveProperty('LD_PRELOAD');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('NODE_PATH');
  });

  it('passes one fixed container-backed Grok sandbox restart to the adapter', async () => {
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

    expect(requested).toEqual(['off']);
    expect(result).toEqual({
      effect: 'restart-required',
      replacementSessionId: 'replacement-session',
    });
  });
});
