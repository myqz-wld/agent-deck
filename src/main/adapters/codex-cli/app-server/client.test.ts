import { describe, expect, it } from 'vitest';

import { __testables } from './client';

describe('Codex app-server thread params', () => {
  it('passes developerInstructions to thread/start and thread/resume only at thread scope', () => {
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      developerInstructions: 'Agent Deck baseline',
    };

    expect(__testables.buildThreadStartParams(options, null)).toMatchObject({
      cwd: '/repo',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions: 'Agent Deck baseline',
    });
    expect(__testables.buildThreadResumeParams('thread-1', options, null)).toMatchObject({
      threadId: 'thread-1',
      cwd: '/repo',
      developerInstructions: 'Agent Deck baseline',
    });
  });

  it('deep-merges custom agent configOverrides over base config for thread/start and thread/resume', () => {
    const baseConfig = {
      mcp_servers: {
        existing: { command: 'tool' },
      },
      sandbox_workspace_write: {
        network_access: false,
      },
    };
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      configOverrides: {
        mcp_servers: {
          agent: { command: 'agent-tool' },
        },
        skills: {
          config: [{ name: 'agent-deck:deep-review' }],
        },
        sandbox_workspace_write: {
          writable_roots: ['/agent'],
        },
      },
    };

    expect(__testables.buildThreadStartParams(options, baseConfig).config).toEqual({
      mcp_servers: {
        existing: { command: 'tool' },
        agent: { command: 'agent-tool' },
      },
      sandbox_workspace_write: {
        network_access: false,
        writable_roots: ['/agent'],
      },
      skills: {
        config: [{ name: 'agent-deck:deep-review' }],
      },
      skip_git_repo_check: true,
    });
    expect(__testables.buildThreadResumeParams('thread-1', options, baseConfig).config).toEqual(
      __testables.buildThreadStartParams(options, baseConfig).config,
    );
  });

  it('adds Codex reasoning summary config without overriding explicit user config', () => {
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      modelReasoningSummary: 'auto' as const,
    };

    expect(__testables.buildThreadStartParams(options, null).config).toMatchObject({
      model_reasoning_summary: 'auto',
      skip_git_repo_check: true,
    });
    expect(
      __testables.buildThreadStartParams(options, { model_reasoning_summary: 'none' }).config,
    ).toMatchObject({
      model_reasoning_summary: 'none',
      skip_git_repo_check: true,
    });
  });

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
});
