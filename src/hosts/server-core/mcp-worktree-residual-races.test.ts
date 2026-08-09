import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '@main/adapters/types';
import { closeDb, initDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { WORKTREE_CLEANUP_UNPROVED_MARKER } from '@main/session/worktree-transition/constants';
import type { AgentEvent, SessionRecord } from '@shared/types';

import {
  ServerCoreWorktreeCleanupUnprovedError,
} from './mcp-worktree-port';
import { ServerCoreWorktreePaths } from './mcp-worktree-paths';
import {
  createServerCorePinnedDirectory,
  createServerCorePinnedWorktree,
} from './mcp-worktree-pinned-create';
import { ServerCoreWorktreeRuntime } from './mcp-worktree-runtime';

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

function createRepository(workspace: string): string {
  const repo = join(workspace, 'repo');
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

function session(id: string, cwd: string): SessionRecord {
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

function event(kind: AgentEvent['kind'], payload: Record<string, unknown>): AgentEvent {
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

function gitWrapper(input: {
  root: string;
  parent: string;
  savedParent: string;
  outside: string;
  makeCleanupFail?: boolean;
}): NodeJS.ProcessEnv {
  const wrapperRoot = join(input.root, 'bin');
  const marker = join(input.root, 'swapped');
  mkdirSync(wrapperRoot);
  const wrapper = join(wrapperRoot, 'git');
  writeFileSync(wrapper, `#!/bin/sh
"$AD_PIN_REAL_GIT" "$@"
status=$?
if [ "$3" = "add" ] && [ ! -e "$AD_PIN_SWAP_MARKER" ] && [ "$status" -eq 0 ]; then
  : > "$AD_PIN_SWAP_MARKER"
  mv "$AD_PIN_SWAP_PARENT" "$AD_PIN_SWAP_SAVED"
  ln -s "$AD_PIN_SWAP_OUTSIDE" "$AD_PIN_SWAP_PARENT"
  if [ "$AD_PIN_FAIL_CLEANUP" = "1" ]; then chmod 0555 "$AD_PIN_SWAP_SAVED"; fi
fi
exit "$status"
`);
  chmodSync(wrapper, 0o755);
  return {
    ...process.env,
    PATH: `${wrapperRoot}${delimiter}${process.env.PATH ?? ''}`,
    AD_PIN_REAL_GIT: executableOnPath('git'),
    AD_PIN_SWAP_MARKER: marker,
    AD_PIN_SWAP_PARENT: input.parent,
    AD_PIN_SWAP_SAVED: input.savedParent,
    AD_PIN_SWAP_OUTSIDE: input.outside,
    AD_PIN_FAIL_CLEANUP: input.makeCleanupFail ? '1' : '0',
  };
}

function nonzeroAddWrapper(input: {
  root: string;
  parent: string;
  savedParent: string;
  finalParent: string;
  outside: string;
}): NodeJS.ProcessEnv {
  const wrapperRoot = join(input.root, 'bin');
  mkdirSync(wrapperRoot);
  const wrapper = join(wrapperRoot, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$3" = "add" ]; then
  mv "$AD_PIN_SWAP_PARENT" "$AD_PIN_SWAP_SAVED"
  ln -s "$AD_PIN_SWAP_OUTSIDE" "$AD_PIN_SWAP_PARENT"
  "$AD_PIN_REAL_GIT" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    mv "$AD_PIN_SWAP_SAVED" "$AD_PIN_SWAP_FINAL"
  fi
  if [ "$status" -eq 0 ]; then exit 7; fi
  exit "$status"
fi
if [ "$3" = "remove" ]; then exit 9; fi
exec "$AD_PIN_REAL_GIT" "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    ...process.env,
    PATH: `${wrapperRoot}${delimiter}${process.env.PATH ?? ''}`,
    AD_PIN_REAL_GIT: executableOnPath('git'),
    AD_PIN_SWAP_PARENT: input.parent,
    AD_PIN_SWAP_SAVED: input.savedParent,
    AD_PIN_SWAP_FINAL: input.finalParent,
    AD_PIN_SWAP_OUTSIDE: input.outside,
  };
}

function largeRegistrationListWrapper(input: {
  root: string;
  head: string;
  count: number;
}): { environment: NodeJS.ProcessEnv; addMarker: string } {
  const wrapperRoot = join(input.root, 'bin');
  const addMarker = join(input.root, 'add-called');
  mkdirSync(wrapperRoot);
  const wrapper = join(wrapperRoot, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$3" = "list" ]; then
  exec "$AD_PIN_NODE" -e 'const z=String.fromCharCode(0); const prefix="/tmp/agent-deck-valid-registration-"+"x".repeat(80)+"-"; const count=Number(process.env.AD_PIN_LIST_COUNT); for (let i=0;i<count;i+=1) process.stdout.write("worktree "+prefix+String(i).padStart(4,"0")+z+"HEAD "+process.env.AD_PIN_HEAD+z+"detached"+z+z);'
fi
if [ "$3" = "add" ]; then : > "$AD_PIN_ADD_MARKER"; fi
exec "$AD_PIN_REAL_GIT" "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    addMarker,
    environment: {
      ...process.env,
      PATH: `${wrapperRoot}${delimiter}${process.env.PATH ?? ''}`,
      AD_PIN_NODE: process.execPath,
      AD_PIN_REAL_GIT: executableOnPath('git'),
      AD_PIN_ADD_MARKER: addMarker,
      AD_PIN_HEAD: input.head,
      AD_PIN_LIST_COUNT: String(input.count),
    },
  };
}

afterEach(() => {
  try { closeDb(); } catch {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Server Core residual worktree races', () => {
  it('pins each missing parent before creating the next segment', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-parent-chain-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    const firstParent = join(repo, 'new-a');
    const savedParent = join(repo, 'new-a-held');
    let calls = 0;
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createDirectory: async (input) => {
        calls += 1;
        if (calls === 2) {
          renameSync(firstParent, savedParent);
          symlinkSync(outside, firstParent);
        }
        await createServerCorePinnedDirectory(input);
      },
    });

    await expect(paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/new-a/new-b/worktree-a',
    })).rejects.toThrow('worktree 父目录');
    expect(calls).toBe(2);
    expect(existsSync(join(outside, 'new-b'))).toBe(false);
    expect(existsSync(join(savedParent, 'new-b'))).toBe(false);
  });

  it('removes a checkout through the pinned parent after the parent pathname moves', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-pinned-cleanup-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    const parent = join(repo, 'prepared-parent');
    const savedParent = join(repo, 'prepared-parent-held');
    const environment = gitWrapper({ root, parent, savedParent, outside });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({ ...input, environment }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await expect(paths.createPrepared(prepared)).rejects.toThrow('Git worktree 创建失败');
      expect(existsSync(join(savedParent, 'worktree-a'))).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('worktree-a');
    } finally {
      prepared.mutationLease.release();
    }
  });

  it('reports cleanup as unproved when the pinned checkout cannot be removed', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-pinned-retain-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    const parent = join(repo, 'prepared-parent');
    const savedParent = join(repo, 'prepared-parent-held');
    const environment = gitWrapper({
      root,
      parent,
      savedParent,
      outside,
      makeCleanupFail: true,
    });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({ ...input, environment }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await expect(paths.createPrepared(prepared))
        .rejects.toBeInstanceOf(ServerCoreWorktreeCleanupUnprovedError);
      expect(existsSync(join(savedParent, 'worktree-a'))).toBe(true);
    } finally {
      if (existsSync(savedParent)) chmodSync(savedParent, 0o755);
      prepared.mutationLease.release();
    }
  });

  it('retains cleanup uncertainty when a nonzero add leaves an intermediate registration', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-pinned-nonzero-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const repo = createRepository(workspace);
    const parent = join(repo, 'prepared-parent');
    const savedParent = join(repo, 'prepared-parent-held');
    const finalParent = join(repo, 'prepared-parent-final');
    const environment = nonzeroAddWrapper({
      root,
      parent,
      savedParent,
      finalParent,
      outside,
    });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({ ...input, environment }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await expect(paths.createPrepared(prepared))
        .rejects.toBeInstanceOf(ServerCoreWorktreeCleanupUnprovedError);
      expect(existsSync(join(finalParent, 'worktree-a'))).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain'))
        .toContain(join(savedParent, 'worktree-a'));
    } finally {
      prepared.mutationLease.release();
    }
  });

  it('accepts a bounded registration snapshot larger than 64 KiB', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-large-registration-list-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    const { environment, addMarker } = largeRegistrationListWrapper({
      root,
      head: git(repo, 'rev-parse', 'HEAD'),
      count: 900,
    });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({ ...input, environment }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await paths.createPrepared(prepared);
      expect(existsSync(addMarker)).toBe(true);
      expect(existsSync(prepared.worktreePath)).toBe(true);
    } finally {
      if (existsSync(prepared.worktreePath)) {
        git(repo, 'worktree', 'remove', '--force', prepared.worktreePath);
      }
      prepared.mutationLease.release();
    }
  });

  it('rejects an over-limit registration snapshot before mutation', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-registration-limit-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    const { environment, addMarker } = largeRegistrationListWrapper({
      root,
      head: git(repo, 'rev-parse', 'HEAD'),
      count: 2_049,
    });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [],
      createWorktree: (input) => createServerCorePinnedWorktree({ ...input, environment }),
    });
    const prepared = await paths.prepareEnter({
      sessionId: 'session-a',
      callerCwd: repo,
      startPoint: 'HEAD',
      worktreePath: 'repo/prepared-parent/worktree-a',
    });
    try {
      await expect(paths.createPrepared(prepared)).rejects.toThrow('Git worktree 创建失败');
      expect(existsSync(addMarker)).toBe(false);
      expect(existsSync(prepared.worktreePath)).toBe(false);
    } finally {
      prepared.mutationLease.release();
    }
  });

  it('retains the durable enter transition when absence cannot prove cleanup', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-unproved-lease-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = createRepository(workspace);
    initDb({
      databasePath: join(root, 'state', 'agent-deck.db'),
      diagnostics: { info: () => undefined, warn: () => undefined },
    });
    sessionRepo.upsert(session('session-a', repo));
    const adapter = {
      id: 'codex-cli',
      getRuntimeCwd: () => repo,
      releaseCwdTransition: vi.fn(),
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
    const internal = runtime as unknown as { paths: ServerCoreWorktreePaths };
    vi.spyOn(internal.paths, 'createPrepared')
      .mockRejectedValueOnce(new ServerCoreWorktreeCleanupUnprovedError());
    try {
      runtime.observe(event('tool-use-start', {
        toolName: 'mcp__agent-deck__enter_worktree',
        toolUseId: 'enter-tool',
      }));
      await expect(runtime.enter('session-a', { startPoint: 'HEAD' }))
        .rejects.toBeInstanceOf(ServerCoreWorktreeCleanupUnprovedError);
      const transition = worktreeTransitionRepo.get('session-a');
      expect(transition?.phase).toBe('creating');
      expect(transition?.lastError).toMatch(
        new RegExp(`^${WORKTREE_CLEANUP_UNPROVED_MARKER}:`),
      );
      expect(existsSync(transition!.worktreePath)).toBe(false);
      runtime.observe(event('tool-use-end', {
        toolUseId: 'enter-tool',
        status: 'error',
      }));
      await until(
        () => worktreeTransitionRepo.get('session-a')?.lastError?.includes('Recovery failed') === true,
        'recovery did not record its retained-state failure',
      );
      const recovered = worktreeTransitionRepo.get('session-a');
      expect(recovered?.phase).toBe('creating');
      expect(recovered?.lastError).toMatch(
        new RegExp(`^${WORKTREE_CLEANUP_UNPROVED_MARKER}:`),
      );
      expect(existsSync(recovered!.worktreePath)).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
});
