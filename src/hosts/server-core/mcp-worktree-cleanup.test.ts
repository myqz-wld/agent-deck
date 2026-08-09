import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { SessionRecord } from '@shared/types';

import { ServerCoreWorktreeCleanup } from './mcp-worktree-cleanup';
import { ServerCoreWorktreePaths } from './mcp-worktree-paths';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

function activate(input: {
  sessionId: string;
  originalCwd: string;
  mainRepo: string;
  worktreePath: string;
}): WorktreeTransitionRecord {
  const created = worktreeTransitionRepo.createEnter({
    sessionId: input.sessionId,
    originalCwd: input.originalCwd,
    targetCwd: input.worktreePath,
    mainRepo: input.mainRepo,
    worktreePath: input.worktreePath,
    baseCommit: git(input.mainRepo, 'rev-parse', 'HEAD'),
    toolUseId: `tool-${input.sessionId}`,
    continuationKey: `worktree:${input.sessionId}`,
    requestedAt: 10,
  });
  worktreeTransitionRepo.markEnterCreated(input.sessionId, created.generation, 11);
  let phase = worktreeTransitionRepo.compareAndSetPhase({
    sessionId: input.sessionId,
    generation: created.generation,
    expected: 'enter_waiting_tool_result',
    next: 'interrupting_enter_turn',
    updatedAt: 12,
  });
  phase = worktreeTransitionRepo.compareAndSetPhase({
    sessionId: input.sessionId,
    generation: phase.generation,
    expected: 'interrupting_enter_turn',
    next: 'switching_to_worktree',
    updatedAt: 13,
  });
  return worktreeTransitionRepo.compareAndSetPhase({
    sessionId: input.sessionId,
    generation: phase.generation,
    expected: 'switching_to_worktree',
    next: 'active',
    updatedAt: 14,
  });
}

afterEach(() => {
  try { closeDb(); } catch {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreWorktreeCleanup transition references', () => {
  it('keeps a worktree that is another active lease original cwd', async () => {
    const root = realpathSync(mkdtempSync('/tmp/agent-deck-core-worktree-cleanup-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const repo = join(workspace, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'tests@example.invalid');
    git(repo, 'config', 'user.name', 'Agent Deck Tests');
    writeFileSync(join(repo, 'README.md'), 'bounded\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'initial');
    const worktreeA = join(workspace, 'worktree-a');
    const worktreeB = join(workspace, 'worktree-b');
    git(repo, 'worktree', 'add', '--detach', worktreeA, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', worktreeB, 'HEAD');
    initDb({
      databasePath: join(root, 'state', 'agent-deck.db'),
      diagnostics: { info: () => undefined, warn: () => undefined },
    });
    sessionRepo.upsert(session('session-a', repo));
    sessionRepo.upsert(session('session-b', worktreeB));
    const recordA = activate({
      sessionId: 'session-a',
      originalCwd: repo,
      mainRepo: repo,
      worktreePath: worktreeA,
    });
    activate({
      sessionId: 'session-b',
      originalCwd: worktreeA,
      mainRepo: repo,
      worktreePath: worktreeB,
    });
    const paths = await ServerCoreWorktreePaths.create({
      workspaceRoot: workspace,
      privateRoots: [join(root, 'state')],
    });
    const cleanup = new ServerCoreWorktreeCleanup({
      paths,
      registry: { list: () => [] },
    });

    await expect(cleanup.cleanup(recordA)).rejects.toThrow(/session-b/);
    expect(existsSync(worktreeA)).toBe(true);
    expect(existsSync(worktreeB)).toBe(true);
  });
});
