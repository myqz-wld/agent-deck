import { describe, expect, it, vi } from 'vitest';

import { __testables } from './client';

describe('Codex app-server workspace thread params', () => {
  it('uses merged configOverrides when building turn/start sandboxPolicy', () => {
    const params = __testables.buildTurnStartParams(
      'thread-1',
      [{ type: 'text', text: 'hi', text_elements: [] }],
      {
        workingDirectory: '/repo',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        configOverrides: {
          sandbox_workspace_write: {
            network_access: true,
            writable_roots: ['/agent'],
            exclude_tmpdir_env_var: true,
          },
        },
      },
      {
        sandbox_workspace_write: {
          network_access: false,
          writable_roots: ['/base'],
        },
      },
    );

    expect(params.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/agent'],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: false,
    });
  });

  it('uses fixed workspace permission profiles for headless threads and turns', () => {
    const assertBoundary = vi.fn();
    const boundary = {
      workspaceRoot: '/worker/workspace',
      selectedDirectory: '/worker/workspace/project-a',
      readOnlyRoots: ['/opt/agent-deck'],
      readWriteRoots: [],
    } as const;
    const options = {
      workingDirectory: '/worker/workspace/project-a',
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      workspacePermissionBoundary: boundary,
      assertWorkspacePermissionBoundary: assertBoundary,
      runtimeWorkspaceRoots: ['/host-must-not-win'],
      additionalDirectories: ['/host-must-not-win'],
      configOverrides: {
        features: { hooks: true, plugins: true },
        mcp_servers: { workspace: { command: './tools/workspace-mcp' } },
        sandbox_mode: 'danger-full-access',
        sandbox_workspace_write: { writable_roots: ['/host-must-not-win'] },
        permissions: {
          'agent-deck-workspace-write-network': {
            filesystem: { ':root': 'write' },
          },
        },
      },
    };

    const start = __testables.buildThreadStartParams(options, {
      sandbox_mode: 'danger-full-access',
    });
    expect(start).toMatchObject({
      cwd: '/worker/workspace/project-a',
      permissions: 'agent-deck-workspace-full-write-network',
      runtimeWorkspaceRoots: ['/worker/workspace/project-a'],
    });
    expect(start).not.toHaveProperty('sandbox');
    expect(start.config).not.toHaveProperty('sandbox_mode');
    expect(start.config).not.toHaveProperty('sandbox_workspace_write');
    expect(start.config).toMatchObject({ features: { hooks: false, plugins: false } });
    expect(start.config).not.toHaveProperty('mcp_servers');
    expect(start.config).not.toHaveProperty('default_permissions');
    expect(start.config).not.toHaveProperty('permissions');
    expect(assertBoundary).toHaveBeenCalledTimes(1);

    const turn = __testables.buildTurnStartParams(
      'thread-1',
      [{ type: 'text', text: 'hi', text_elements: [] }],
      options,
      null,
      { runtimeWorkspaceRoots: ['/turn-must-not-win'] },
    );
    expect(turn).toMatchObject({
      permissions: 'agent-deck-workspace-full-write-network',
      runtimeWorkspaceRoots: ['/worker/workspace/project-a'],
    });
    expect(turn).not.toHaveProperty('sandboxPolicy');
    expect(assertBoundary).toHaveBeenCalledTimes(2);

    const selectedWrite = __testables.buildThreadStartParams({
      ...options,
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
    }, null);
    expect(selectedWrite).toMatchObject({
      permissions: 'agent-deck-workspace-write',
      runtimeWorkspaceRoots: ['/worker/workspace/project-a'],
    });
    expect(assertBoundary).toHaveBeenCalledTimes(3);
  });

  it('keeps read-only headless sessions inside the same workspace ceiling', () => {
    const options = {
      workingDirectory: '/worker/workspace',
      sandboxMode: 'read-only' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      workspacePermissionBoundary: {
        workspaceRoot: '/worker/workspace',
        selectedDirectory: '/worker/workspace',
        readOnlyRoots: ['/opt/agent-deck'],
        readWriteRoots: [],
      },
    };
    expect(__testables.buildThreadStartParams(options, null)).toMatchObject({
      permissions: 'agent-deck-workspace-read-only',
      runtimeWorkspaceRoots: ['/worker/workspace'],
    });
    expect(() =>
      __testables.buildThreadStartParams(
        { ...options, workingDirectory: '/worker/private/ssh' },
        null,
      ),
    ).toThrow('escapes the Server Core workspace');
  });
});
