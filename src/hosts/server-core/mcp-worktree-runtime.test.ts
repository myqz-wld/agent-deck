import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, AgentCwdTransition } from '@main/adapters/types';
import { closeDb, initDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { AgentEvent, SessionRecord } from '@shared/types';

import { ServerCoreWorktreePaths } from './mcp-worktree-paths';
import { createServerCorePinnedWorktree } from './mcp-worktree-pinned-create';
import { ServerCoreWorktreeRuntime } from './mcp-worktree-runtime';
import {
  serverCoreWorktreeReferenceFence,
  type ServerCoreWorktreeReferenceLease,
} from './worktree-reference-fence';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function executableOnPath(command: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${command} executable is unavailable`);
}

function createRepository(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'tests@example.invalid');
  git(repo, 'config', 'user.name', 'Agent Deck Tests');
  writeFileSync(join(repo, 'README.md'), 'bounded\n');
  writeFileSync(join(repo, '.gitignore'), '.agent-deck/\n');
  git(repo, 'add', 'README.md', '.gitignore');
  git(repo, 'commit', '-m', 'initial');
  return realpathSync(repo);
}

function record(id: string, cwd: string): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd,
    title: id,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

function event(
  kind: AgentEvent['kind'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    sessionId: 'session-a',
    agentId: 'codex-cli',
    kind,
    payload,
    ts: Date.now(),
    source: 'sdk',
  };
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

afterEach(() => {
  try { closeDb(); } catch {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreWorktreeRuntime', () => {
  it('moves a real provider session through enter, buffered input, and clean exit', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    initDb({
      databasePath: join(root, 'state', 'agent-deck.db'),
      diagnostics: { info: () => undefined, warn: () => undefined },
    });
    sessionRepo.upsert(record('session-a', repo));

    let runtimeCwd = repo;
    const armed: AgentCwdTransition[] = [];
    const replayed: string[] = [];
    const interruptSession = vi.fn(async () => undefined);
    const adapter = {
      id: 'codex-cli',
      armCwdTransition: (transition: AgentCwdTransition) => armed.push(transition),
      switchCwdForTransition: async (transition: AgentCwdTransition) => {
        runtimeCwd = transition.targetCwd;
        return { continuationAccepted: true };
      },
      releaseCwdTransition: vi.fn(),
      getRuntimeCwd: () => runtimeCwd,
      interruptSession,
      enqueueMessage: async (_id: string, text: string) => { replayed.push(text); },
    } as unknown as AgentAdapter;
    const statuses: string[] = [];
    const runtime = new ServerCoreWorktreeRuntime({
      workspaceRoot: workspace,
      privateRoots: [join(root, 'state')],
      sessions: sessionRepo,
      registry: { get: () => adapter, list: () => [adapter] },
      publishSession: () => undefined,
      publishStatus: (_id, text) => statuses.push(text),
      appendChange: () => undefined,
      warn: () => undefined,
    });
    await runtime.start();
    try {
      runtime.observe(event('tool-use-start', {
        toolName: 'mcp__agent-deck__enter_worktree',
        toolUseId: 'enter-tool',
      }));
      const entered = await runtime.enter('session-a', { startPoint: 'HEAD' });
      expect(entered).toMatchObject({
        direction: 'enter',
        state: 'waiting-tool-result',
        headMode: 'detached',
      });
      expect(JSON.stringify(entered)).not.toContain(workspace);
      expect(armed).toHaveLength(1);
      expect(runtime.guardIngress({
        sourceSessionId: 'session-a',
        agentId: 'codex-cli',
        text: 'continue after the switch',
        emit: () => undefined,
      })).toBe(true);

      runtime.observe(event('tool-use-end', { toolUseId: 'enter-tool', status: 'success' }));
      await until(() => interruptSession.mock.calls.length === 1, 'enter interrupt was not requested');
      runtime.observe(event('finished', {}));
      await until(
        () => worktreeTransitionRepo.get('session-a')?.phase === 'active',
        'enter transition did not become active',
      );
      const active = worktreeTransitionRepo.get('session-a')!;
      expect(sessionRepo.get('session-a')?.cwd).toBe(active.worktreePath);
      expect(replayed).toEqual(['continue after the switch']);
      expect(statuses.at(-1)).toContain('已切换');

      runtime.observe(event('tool-use-start', {
        toolName: 'mcp__agent-deck__exit_worktree',
        toolUseId: 'exit-tool',
      }));
      const exited = await runtime.exit('session-a', {});
      expect(exited).toMatchObject({
        direction: 'exit',
        state: 'waiting-tool-result',
        worktreePath: entered.worktreePath,
      });
      runtime.observe(event('tool-use-end', { toolUseId: 'exit-tool', status: 'success' }));
      await until(() => interruptSession.mock.calls.length === 2, 'exit interrupt was not requested');
      runtime.observe(event('finished', {}));
      await until(
        () => worktreeTransitionRepo.get('session-a')?.phase === 'cleared',
        'exit transition did not clear',
      );
      expect(sessionRepo.get('session-a')?.cwd).toBe(repo);
      expect(() => realpathSync(active.worktreePath)).toThrow();
    } finally {
      await runtime.stop();
    }
  });

  it('rejects a repository whose Git common directory is outside the Workspace', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-boundary-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const outsideRepo = createRepository(outside);
    const linked = join(workspace, 'linked');
    git(outsideRepo, 'worktree', 'add', '--detach', linked, 'HEAD');
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
    });
    await expect(paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: linked,
      startPoint: 'HEAD',
    })).rejects.toMatchObject({
      name: 'ServerCoreWorktreeError',
      message: expect.stringContaining('Workspace'),
    });
  });

  it('rejects absolute and traversal worktree paths without creating a lease', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-input-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runGit = vi.fn(async () => '');
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      runGit,
    });
    for (const worktreePath of ['/tmp/escape', '../escape']) {
      await expect(paths.prepareEnter({
        sessionId: 'session-a',
        callerCwd: join(workspace, 'missing'),
        startPoint: 'HEAD',
        worktreePath,
      })).rejects.toThrow(/worktreePath|session-console contract/i);
    }
    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects a symlinked default parent before creating anything outside Workspace', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-symlink-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    symlinkSync(outside, join(repo, '.agent-deck'));
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
    });

    await expect(paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
    })).rejects.toThrow('worktree 父目录');
    expect(existsSync(join(outside, 'worktrees'))).toBe(false);
  });

  it('pins the prepared parent across Git child path resolution', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-reswap-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    const parent = join(repo, 'prepared-parent');
    const savedParent = join(repo, 'prepared-parent-held');
    const wrapperRoot = join(root, 'bin');
    const marker = join(root, 'swapped');
    mkdirSync(wrapperRoot);
    const realGit = executableOnPath('git');
    const wrapper = join(wrapperRoot, 'git');
    writeFileSync(wrapper, `#!/bin/sh
if [ ! -e "$AD_PIN_SWAP_MARKER" ]; then
  : > "$AD_PIN_SWAP_MARKER"
  mv "$AD_PIN_SWAP_PARENT" "$AD_PIN_SWAP_SAVED"
  ln -s "$AD_PIN_SWAP_OUTSIDE" "$AD_PIN_SWAP_PARENT"
fi
exec "$AD_PIN_REAL_GIT" "$@"
`);
    chmodSync(wrapper, 0o755);
    const environment = {
      ...process.env,
      PATH: `${wrapperRoot}${delimiter}${process.env.PATH ?? ''}`,
      AD_PIN_REAL_GIT: realGit,
      AD_PIN_SWAP_MARKER: marker,
      AD_PIN_SWAP_OUTSIDE: outside,
      AD_PIN_SWAP_PARENT: parent,
      AD_PIN_SWAP_SAVED: savedParent,
    };
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({
        ...input,
        environment,
      }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await expect(paths.createPrepared(prepared)).rejects.toThrow('Git worktree 创建失败');
      expect(existsSync(join(outside, 'worktree-a'))).toBe(false);
      expect(existsSync(join(savedParent, 'worktree-a'))).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(outside);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(savedParent);
    } finally {
      prepared.mutationLease.release();
    }
  });

  it('blocks enter parent creation while overlapping cleanup is active', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-overlap-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    const retiring = join(repo, 'retiring-root');
    const cleanup = serverCoreWorktreeReferenceFence.acquireCleanup(retiring);
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
    });
    try {
      await expect(paths.prepareEnter({
        sessionId: 'session-a',
        callerCwd: repo,
        startPoint: 'HEAD',
        worktreePath: 'repo/retiring-root/nested',
      })).rejects.toThrow('生命周期操作');
      expect(existsSync(retiring)).toBe(false);
    } finally {
      cleanup.release();
    }
  });

  it('keeps an unconfirmed worktree when rollback meets an active registration reference', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-rollback-fence-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    initDb({
      databasePath: join(root, 'state', 'agent-deck.db'),
      diagnostics: { info: () => undefined, warn: () => undefined },
    });
    sessionRepo.upsert(record('session-a', repo));
    const registration: { current: ServerCoreWorktreeReferenceLease | null } = {
      current: null,
    };
    const adapter = {
      id: 'codex-cli',
      armCwdTransition: (transition: AgentCwdTransition) => {
        registration.current = serverCoreWorktreeReferenceFence.acquireReference(
          transition.targetCwd,
        );
        throw new Error('arm failed after registration');
      },
      switchCwdForTransition: async () => ({ continuationAccepted: true }),
      getRuntimeCwd: () => repo,
      releaseCwdTransition: vi.fn(),
      interruptSession: vi.fn(async () => undefined),
      enqueueMessage: vi.fn(async () => undefined),
    } as unknown as AgentAdapter;
    const runtime = new ServerCoreWorktreeRuntime({
      workspaceRoot: workspace,
      privateRoots: [join(root, 'state')],
      sessions: sessionRepo,
      registry: { get: () => adapter, list: () => [adapter] },
      publishSession: () => undefined,
      publishStatus: () => undefined,
      appendChange: () => undefined,
      warn: () => undefined,
    });
    await runtime.start();
    try {
      runtime.observe(event('tool-use-start', {
        toolName: 'mcp__agent-deck__enter_worktree',
        toolUseId: 'enter-tool',
      }));
      await expect(runtime.enter('session-a', { startPoint: 'HEAD' }))
        .rejects.toThrow('enter_worktree 准备失败');
      const transition = worktreeTransitionRepo.get('session-a');
      expect(transition?.lastError).toContain('rollback');
      expect(existsSync(transition!.worktreePath)).toBe(true);
    } finally {
      registration.current?.release();
      const transition = worktreeTransitionRepo.get('session-a');
      if (transition && existsSync(transition.worktreePath)) {
        git(repo, 'worktree', 'remove', '--force', transition.worktreePath);
      }
      await runtime.stop();
    }
  });

  it('requires the exact default-root ignore entry without editing the repository', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-ignore-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
    });

    await expect(paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
    })).rejects.toThrow('尚未被 Git 忽略');
    expect(existsSync(join(repo, '.agent-deck'))).toBe(false);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('build/\n');
  });
});
