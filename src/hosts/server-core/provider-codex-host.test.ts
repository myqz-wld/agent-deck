import { describe, expect, it } from 'vitest';

import type { ServerCoreProviderHostInput } from './provider-host-common';
import {
  codexProcessEnvironment,
  withServerCoreCodexWorkspaceBoundary,
} from './provider-codex-host';
import {
  buildCodexWorkspaceAppServerArguments,
  buildCodexWorkspacePermissionProfiles,
} from '@main/adapters/codex-cli/app-server/workspace-permissions';

describe('Server Core Codex process environment', () => {
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
    const input = {
      workspaceBoundary: {
        workspaceRoot: '/workspace',
        privateRoot: '/state/private',
        providerHomeRoot: '/state/provider-home',
        runtimeReadRoots: ['/opt/agent-deck'],
        providerCacheRoot: '/private/provider-cache',
        providerTempRoot: '/private/provider-tmp',
      },
    } as unknown as ServerCoreProviderHostInput;
    const mode = withServerCoreCodexWorkspaceBoundary({
      mode: 'resume',
      threadId: 'thread-1',
      options: {
        workingDirectory: '/workspace/project',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        runtimeWorkspaceRoots: ['/outside'],
      },
    }, input);

    expect(mode).toEqual({
      mode: 'resume',
      threadId: 'thread-1',
      options: expect.objectContaining({
        runtimeWorkspaceRoots: ['/workspace'],
        workspacePermissionBoundary: {
          workspaceRoot: '/workspace',
          readOnlyRoots: ['/opt/agent-deck'],
          readWriteRoots: [],
        },
      }),
    });
    expect(Object.isFrozen(mode)).toBe(true);
    expect(Object.isFrozen(mode.options.workspacePermissionBoundary)).toBe(true);
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
    });

    const args = buildCodexWorkspaceAppServerArguments(boundary);
    expect(args.slice(-2)).toEqual(['app-server', '--stdio']);
    expect(args).toContain('default_permissions="agent-deck-workspace-read-only"');
    const permissionOverride = args.find((arg) => arg.startsWith('permissions='));
    expect(permissionOverride).toContain('"/opt/Agent Deck/runtime"="read"');
    expect(permissionOverride).toContain('":root"="deny"');
    expect(permissionOverride).not.toContain('/state/private');
    expect(args).not.toContain('mcp_servers={}');
    expect(args).not.toContain('features.plugins=false');
    expect(args).not.toContain('features.hooks=false');
  });
});
