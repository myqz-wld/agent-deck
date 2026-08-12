import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ServerCoreProviderHostInput } from './provider-host-common';
import {
  codexProcessEnvironment,
  createServerCoreCodexUsageSnapshotHost,
  withServerCoreCodexWorkspaceBoundary,
} from './provider-codex-host';
import {
  buildCodexWorkspaceAppServerArguments,
  buildCodexWorkspacePermissionProfiles,
} from '@main/adapters/codex-cli/app-server/workspace-permissions';
import { buildThreadStartParams } from '@main/adapters/codex-cli/app-server/thread-params';

describe('Server Core Codex process environment', () => {
  it('binds the quota probe to the Worker-private Codex home and probe directory', () => {
    const input = {
      settings: { codexCliPath: '/opt/providers/codex' },
      workspaceBoundary: {
        workspaceRoot: '/workspaces',
        privateRoot: '/private/worker',
        providerHomeRoot: '/private/worker/provider-home',
        runtimeReadRoots: ['/opt/providers'],
        providerCacheRoot: '/private/worker/provider-cache',
        providerTempRoot: '/private/worker/provider-tmp',
      },
    } as unknown as ServerCoreProviderHostInput;

    const host = createServerCoreCodexUsageSnapshotHost(input);
    expect(host.readCodexCliPath()).toBe('/opt/providers/codex');
    expect(host.readProbeCwd()).toBe('/private/worker/provider-tmp');
    expect(host.snapshotProcessEnv()).toMatchObject({
      HOME: '/private/worker/provider-home',
      CODEX_HOME: '/private/worker/provider-home/.codex',
      TMPDIR: '/private/worker/provider-tmp',
    });
  });

  it('prepends only the signed sibling tool directory when its rg exists', () => {
    const source = { HOME: '/private/worker', PATH: '/usr/bin:/bin' };
    const executable = '/Applications/Agent Deck.app/Contents/MacOS/' +
      'Agent Deck Worker Providers/codex/bin/codex';
    const expectedRg = '/Applications/Agent Deck.app/Contents/MacOS/' +
      'Agent Deck Worker Providers/codex/codex-path/rg';
    expect(codexProcessEnvironment(
      executable,
      source,
      (candidate) => candidate === expectedRg,
    )).toEqual({
      HOME: '/private/worker',
      PATH: '/Applications/Agent Deck.app/Contents/MacOS/' +
        'Agent Deck Worker Providers/codex/codex-path:/usr/bin:/bin',
    });
    expect(source.PATH).toBe('/usr/bin:/bin');
  });

  it('does not infer a broad tools path when the exact helper is absent', () => {
    expect(codexProcessEnvironment(
      '/custom/codex',
      { PATH: '/usr/bin:/bin' },
      () => false,
    )).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('injects an immutable workspace ceiling after session options are resolved', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-core-codex-policy-')));
    const workspace = join(root, 'workspace');
    const selected = join(workspace, 'project');
    const privateRoot = join(root, 'private');
    const providerHome = join(privateRoot, 'provider-home');
    const providerCache = join(privateRoot, 'provider-cache');
    const providerTemp = join(privateRoot, 'provider-tmp');
    const runtime = join(root, 'runtime');
    for (const path of [selected, providerHome, providerCache, providerTemp, runtime]) {
      mkdirSync(path, { mode: 0o700, recursive: true });
    }
    const input = {
      workspaceBoundary: {
        workspaceRoot: workspace,
        privateRoot,
        providerHomeRoot: providerHome,
        runtimeReadRoots: [runtime],
        providerCacheRoot: providerCache,
        providerTempRoot: providerTemp,
      },
    } as unknown as ServerCoreProviderHostInput;
    try {
      const mode = withServerCoreCodexWorkspaceBoundary({
        mode: 'resume',
        threadId: 'thread-1',
        options: {
          workingDirectory: selected,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        },
      }, input);

      expect(mode).toEqual({
        mode: 'resume',
        threadId: 'thread-1',
        options: expect.objectContaining({
          workingDirectory: selected,
          runtimeWorkspaceRoots: [selected],
          workspacePermissionBoundary: {
            workspaceRoot: workspace,
            selectedDirectory: selected,
            readOnlyRoots: [runtime],
            readWriteRoots: [],
          },
        }),
      });
      expect(mode.options).not.toHaveProperty('additionalDirectories');
      expect(Object.isFrozen(mode)).toBe(true);
      expect(Object.isFrozen(mode.options.workspacePermissionBoundary)).toBe(true);

      renameSync(selected, `${selected}-replaced`);
      mkdirSync(selected, { mode: 0o700 });
      expect(() => buildThreadStartParams(mode.options, null))
        .toThrow('identity changed');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects requested write roots instead of silently narrowing them', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-core-codex-roots-')));
    const workspace = join(root, 'workspace');
    const selected = join(workspace, 'project');
    const privateRoot = join(root, 'private');
    const providerHome = join(privateRoot, 'provider-home');
    const providerCache = join(privateRoot, 'provider-cache');
    const providerTemp = join(privateRoot, 'provider-tmp');
    const runtime = join(root, 'runtime');
    for (const path of [selected, providerHome, providerCache, providerTemp, runtime]) {
      mkdirSync(path, { mode: 0o700, recursive: true });
    }
    const input = {
      workspaceBoundary: {
        workspaceRoot: workspace,
        privateRoot,
        providerHomeRoot: providerHome,
        runtimeReadRoots: [runtime],
        providerCacheRoot: providerCache,
        providerTempRoot: providerTemp,
      },
    } as unknown as ServerCoreProviderHostInput;
    const options = {
      workingDirectory: selected,
      sandboxMode: 'workspace-write' as const,
      skipGitRepoCheck: true,
    };
    try {
      expect(() => withServerCoreCodexWorkspaceBoundary({
        mode: 'start', options: { ...options, additionalDirectories: ['/outside'] },
      }, input)).toThrow('additional write roots');
      expect(() => withServerCoreCodexWorkspaceBoundary({
        mode: 'start', options: { ...options, runtimeWorkspaceRoots: ['/outside'] },
      }, input)).toThrow('additional runtime Workspace roots');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('installs fixed process-level permission profiles for every workspace mode', () => {
    const boundary = {
      workspaceRoot: '/Workspace',
      readOnlyRoots: ['/opt/Agent Deck/runtime'],
      readWriteRoots: [],
    } as const;

    expect(buildCodexWorkspacePermissionProfiles(boundary)).toMatchObject({
      'agent-deck-workspace-read-only': {
        filesystem: {
          ':root': 'deny',
          ':minimal': 'read',
          ':workspace_roots': { '.': 'read' },
          '/opt/Agent Deck/runtime': 'read',
        },
        network: { enabled: false },
      },
      'agent-deck-workspace-write-network': {
        filesystem: {
          ':root': 'deny',
          ':minimal': 'read',
          ':workspace_roots': { '.': 'write' },
          '/opt/Agent Deck/runtime': 'read',
        },
        network: { enabled: true, domains: { '*': 'allow' } },
      },
      'agent-deck-workspace-full-write': {
        filesystem: {
          ':workspace_roots': { '.': 'write' },
          '/Workspace': 'write',
        },
      },
    });

    const args = buildCodexWorkspaceAppServerArguments(boundary);
    expect(args.slice(-2)).toEqual(['app-server', '--stdio']);
    expect(args).toContain('default_permissions="agent-deck-workspace-read-only"');
    const permissionOverride = args.find((arg) => arg.startsWith('permissions='));
    expect(permissionOverride).toContain('"/opt/Agent Deck/runtime"="read"');
    expect(permissionOverride).toContain('":root"="deny"');
    expect(permissionOverride).not.toContain('/state/private');
    expect(args).toContain('mcp_servers={}');
    expect(args).toContain('features.plugins=false');
    expect(args).toContain('features.hooks=false');
  });
});
