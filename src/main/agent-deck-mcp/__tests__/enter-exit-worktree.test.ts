import { describe, expect, it } from 'vitest';
import {
  enterWorktreeImpl,
  _internalIsError as enterIsError,
  type EnterWorktreeDeps,
} from '../tools/handlers/enter-worktree-impl';
import {
  exitWorktreeImpl,
  _internalIsError as exitIsError,
} from '../tools/handlers/exit-worktree-impl';

function queuedGit(
  calls: Array<{ args: string[]; cwd: string }>,
  values: Array<string | Error>,
): NonNullable<EnterWorktreeDeps['runGit']> {
  const queue = [...values];
  return async (args, cwd) => {
    calls.push({ args, cwd });
    const next = queue.shift();
    if (next === undefined) throw new Error(`runGit mock exhausted: ${args.join(' ')}`);
    if (next instanceof Error) throw next;
    return next;
  };
}

describe('enterWorktreeImpl', () => {
  it('requires a local baseBranch and creates a fresh work branch from that commit', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const mkdirs: string[] = [];
    const markers: Array<{ sid: string; marker: string }> = [];

    const result = await enterWorktreeImpl(
      {
        callerSessionId: 'caller-sid',
        baseBranch: 'main',
        workBranchOverride: 'agent-deck/test-work',
        worktreeRootOverride: '/repo/.agent-deck/worktrees',
      },
      {
        runGit: queuedGit(calls, [
          '/repo/.git',
          '',
          'base-sha',
          new Error('missing branch'),
          '',
          '',
        ]),
        exists: async () => false,
        mkdir: async (p) => {
          mkdirs.push(p);
        },
        callerCwd: () => '/repo/src',
        setCwdReleaseMarker: (sid, marker) => {
          markers.push({ sid, marker });
        },
      },
    );

    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result).toMatchObject({
      worktreePath: '/repo/.agent-deck/worktrees/agent-deck__test-work',
      workBranch: 'agent-deck/test-work',
      baseBranch: 'main',
      baseCommit: 'base-sha',
      baseSource: 'base-branch',
      markerSet: true,
    });
    expect(mkdirs).toEqual(['/repo/.agent-deck/worktrees']);
    expect(markers).toEqual([
      { sid: 'caller-sid', marker: '/repo/.agent-deck/worktrees/agent-deck__test-work' },
    ]);
    expect(calls.map((c) => c.args)).toContainEqual([
      'worktree',
      'add',
      '-b',
      'agent-deck/test-work',
      '/repo/.agent-deck/worktrees/agent-deck__test-work',
      'base-sha',
    ]);
  });

  it('rejects ref syntax in baseBranch before running git', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const result = await enterWorktreeImpl(
      { callerSessionId: 'caller-sid', baseBranch: 'main~1' },
      {
        runGit: queuedGit(calls, ['/repo/.git']),
        exists: async () => false,
        mkdir: async () => undefined,
        callerCwd: () => '/repo',
        setCwdReleaseMarker: () => undefined,
      },
    );

    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('baseBranch must be a plain local branch name');
  });
});

describe('exitWorktreeImpl', () => {
  it('removes a clean worktree and keeps the branch by default', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const cleared: string[] = [];

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit(calls, ['/repo/.git', 'agent-deck/test-work', '', '']),
        exists: async () => true,
        realpath: async (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        clearCwdReleaseMarker: (sid) => {
          cleared.push(sid);
        },
      },
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result).toEqual({
      worktreePath: '/repo/.agent-deck/worktrees/test',
      workBranch: 'agent-deck/test-work',
      branchDeleted: false,
      worktreeRemoved: true,
      markerCleared: true,
    });
    expect(calls.map((c) => c.args)).not.toContainEqual(['branch', '-d', 'agent-deck/test-work']);
    expect(cleared).toEqual(['caller-sid']);
  });

  it('deletes the branch only when deleteBranch is true', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];

    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid', deleteBranch: true },
      {
        runGit: queuedGit(calls, ['/repo/.git', 'agent-deck/test-work', '', '', '']),
        exists: async () => true,
        realpath: async (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result.branchDeleted).toBe(true);
    expect(calls.map((c) => c.args)).toContainEqual(['branch', '-d', 'agent-deck/test-work']);
  });

  it('rejects dirty worktrees unless discardChanges is true', async () => {
    const result = await exitWorktreeImpl(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit([], ['/repo/.git', 'agent-deck/test-work', ' M file.txt']),
        exists: async () => true,
        realpath: async (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('worktree has uncommitted changes');
    expect(result.markerCleared).toBe(false);
  });

  it('rejects an explicit path that differs from the caller marker', async () => {
    const result = await exitWorktreeImpl(
      {
        callerSessionId: 'caller-sid',
        worktreePathOverride: '/repo/.agent-deck/worktrees/other',
      },
      {
        runGit: queuedGit([], []),
        exists: async () => true,
        realpath: async (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('does not match caller marker');
  });
});
