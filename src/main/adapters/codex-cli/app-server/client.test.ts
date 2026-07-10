import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, __testables } from './client';

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
    expect(__testables.buildThreadForkParams('source-1', 'turn-1', options, null)).toMatchObject({
      threadId: 'source-1',
      lastTurnId: 'turn-1',
      cwd: '/repo',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
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
    expect(__testables.buildThreadForkParams('source-1', 'turn-1', options, baseConfig).config)
      .toEqual(__testables.buildThreadStartParams(options, baseConfig).config);
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

  it('issues exact read, fork, inject, and delete RPC payloads through one client', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    class RecordingClient extends CodexAppServerClient {
      override request<T = unknown>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === 'thread/read') {
          return Promise.resolve({ thread: { id: 'source', turns: [] } } as T);
        }
        if (method === 'thread/fork') {
          return Promise.resolve({
            thread: { id: 'child', forkedFromId: 'source', turns: [] },
          } as T);
        }
        return Promise.resolve({} as T);
      }
    }
    const client = new RecordingClient({ env: {}, config: null });
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      model: 'target-model',
      modelReasoningEffort: 'high' as const,
      developerInstructions: 'target instructions',
    };

    await client.readThread('source');
    await client.forkThread('source', 'terminal-turn', options);
    await client.injectThreadItems('child', [{
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'reset' }],
    }]);
    await client.deleteThread('child');

    expect(calls).toEqual([
      { method: 'thread/read', params: { threadId: 'source', includeTurns: true } },
      {
        method: 'thread/fork',
        params: expect.objectContaining({
          threadId: 'source',
          lastTurnId: 'terminal-turn',
          cwd: '/repo',
          sandbox: 'workspace-write',
          approvalPolicy: 'never',
          model: 'target-model',
          developerInstructions: 'target instructions',
          config: expect.objectContaining({ model_reasoning_effort: 'high' }),
        }),
      },
      {
        method: 'thread/inject_items',
        params: {
          threadId: 'child',
          items: [expect.objectContaining({ role: 'developer' })],
        },
      },
      { method: 'thread/delete', params: { threadId: 'child' } },
    ]);
  });

  it('forces thread/resume when the creating process exited before child adoption', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    class ExitedClient extends CodexAppServerClient {
      override request<T = unknown>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        return Promise.resolve({ thread: { id: 'child' } } as T);
      }
    }
    const client = new ExitedClient({ env: {}, config: null });
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    };

    const adopted = client.adoptThread('child', options);
    await adopted.ensureReady();

    expect(calls).toEqual([{
      method: 'thread/resume',
      params: expect.objectContaining({ threadId: 'child', cwd: '/repo' }),
    }]);
  });
});
