import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  enterWorktreeImpl,
  rollbackPreparedWorktree,
  _internalIsError as enterIsError,
  type EnterWorktreeDeps,
} from '../tools/handlers/enter-worktree-impl';
import {
  prepareLegacyWorktreeExit,
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
  it('freezes startPoint and creates a detached worktree without branch commands', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const mkdirs: string[] = [];
    const markers: Array<{ sid: string; marker: string }> = [];
    const startCommit = 'a'.repeat(40);

    const result = await enterWorktreeImpl(
      {
        callerSessionId: 'caller-sid',
        startPoint: 'main~1',
        worktreeRootOverride: '/repo/.agent-deck/worktrees',
      },
      {
        runGit: queuedGit(calls, [
          '/repo/.git',
          startCommit,
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
        now: () => 1,
      },
    );

    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result).toMatchObject({
      worktreePath: '/repo/.agent-deck/worktrees/agent-deck-caller-sid-1',
      startCommit,
      headMode: 'detached',
      markerSet: true,
    });
    expect(mkdirs).toEqual(['/repo/.agent-deck/worktrees']);
    expect(markers).toEqual([
      {
        sid: 'caller-sid',
        marker: '/repo/.agent-deck/worktrees/agent-deck-caller-sid-1',
      },
    ]);
    expect(calls.map((c) => c.args)).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'main~1^{commit}',
    ]);
    expect(calls.map((c) => c.args)).toContainEqual([
      'worktree',
      'add',
      '--detach',
      '/repo/.agent-deck/worktrees/agent-deck-caller-sid-1',
      startCommit,
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain('branch');
    expect(calls.flatMap((call) => call.args)).not.toContain('-b');
  });

  it('rejects an unsafe startPoint before trying to resolve it', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const result = await enterWorktreeImpl(
      { callerSessionId: 'caller-sid', startPoint: 'main branch' },
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
    expect(result.error).toContain('startPoint must be one non-empty Git revision');
    expect(calls.map((call) => call.args)).toEqual([
      ['rev-parse', '--git-common-dir'],
    ]);
  });

  it('treats a pre-creation git failure as a complete no-op rollback', async () => {
    const warnings = await rollbackPreparedWorktree(
      {
        callerSessionId: 'caller-sid',
        originalCwd: '/repo',
        mainRepo: '/repo',
        worktreePath: '/repo/.agent-deck/worktrees/task',
        startCommit: 'a'.repeat(40),
      },
      {
        exists: async () => false,
        runGit: async () => {
          throw new Error('worktree was never created');
        },
      },
    );

    expect(warnings).toEqual([]);
  });

  it('rollback removes only a safe worktree and never invokes a branch command', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const warnings = await rollbackPreparedWorktree(
      {
        callerSessionId: 'caller-sid',
        originalCwd: '/repo',
        mainRepo: '/repo',
        worktreePath: '/repo/.agent-deck/worktrees/task',
        startCommit: 'a'.repeat(40),
      },
      {
        exists: async () => true,
        runGit: queuedGit(calls, [
          '',
          'a'.repeat(40),
          'refs/heads/main',
          '',
        ]),
      },
    );

    expect(warnings).toEqual([]);
    expect(calls.map((call) => call.args)).toContainEqual([
      'worktree',
      'remove',
      '/repo/.agent-deck/worktrees/task',
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain('branch');
  });

  it('creates a real detached worktree without changing the repository ref set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-detached-enter-'));
    const mainRepo = join(root, 'repo');
    const worktreePath = join(root, 'worktree');
    try {
      mkdirSync(mainRepo);
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: mainRepo,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: mainRepo,
      });
      execFileSync('git', ['config', 'user.name', 'Agent Deck Test'], {
        cwd: mainRepo,
      });
      writeFileSync(join(mainRepo, 'tracked.txt'), 'baseline\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-m', 'baseline'], {
        cwd: mainRepo,
        stdio: 'ignore',
      });
      const refsBefore = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname):%(objectname)'],
        { cwd: mainRepo, encoding: 'utf8' },
      );

      const result = await enterWorktreeImpl(
        {
          callerSessionId: 'caller-sid',
          startPoint: 'HEAD',
          worktreePathOverride: worktreePath,
        },
        {
          callerCwd: () => mainRepo,
          setCwdReleaseMarker: () => undefined,
        },
      );

      expect(enterIsError(result)).toBe(false);
      if (enterIsError(result)) return;
      expect(result.headMode).toBe('detached');
      expect(
        () =>
          execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
            cwd: worktreePath,
            stdio: 'ignore',
          }),
      ).toThrow();
      const refsAfter = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname):%(objectname)'],
        { cwd: mainRepo, encoding: 'utf8' },
      );
      expect(refsAfter).toBe(refsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepareLegacyWorktreeExit', () => {
  it('prepares a clean legacy worktree without removing it in the request', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const cleared: string[] = [];

    const result = await prepareLegacyWorktreeExit(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit(calls, [
          '/repo/.git',
          'head-sha',
          'refs/heads/agent-deck/test-work',
          '',
        ]),
        exists: () => true,
        realpath: (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        callerCwd: () => '/repo/.agent-deck/worktrees/test/src',
        clearCwdReleaseMarker: (sid) => {
          cleared.push(sid);
        },
      },
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result).toEqual({
      kind: 'ready',
      expectedMarker: '/repo/.agent-deck/worktrees/test',
      originalCwd: '/repo',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/test',
      headCommit: 'head-sha',
    });
    expect(calls.map((c) => c.args)).not.toContainEqual([
      'worktree',
      'remove',
      '/repo/.agent-deck/worktrees/test',
    ]);
    expect(cleared).toEqual([]);
  });

  it('adopts a detached legacy worktree and preserves an outside original cwd', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];

    const result = await prepareLegacyWorktreeExit(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit(calls, [
          '/repo/.git',
          'head-sha',
          'refs/heads/main',
          '',
        ]),
        exists: () => true,
        realpath: (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        callerCwd: () => '/outside',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(false);
    if (exitIsError(result)) return;
    expect(result).toMatchObject({
      kind: 'ready',
      originalCwd: '/outside',
      headCommit: 'head-sha',
    });
  });

  it('rejects dirty worktrees unless discardChanges is true', async () => {
    const result = await prepareLegacyWorktreeExit(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit(
          [],
          [
            '/repo/.git',
            'head-sha',
            'refs/heads/agent-deck/test-work',
            ' M file.txt',
          ],
        ),
        exists: () => true,
        realpath: (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        callerCwd: () => '/repo',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('worktree has uncommitted changes');
    expect(result.markerCleared).toBe(false);
  });

  it('rejects an unreferenced HEAD even when dirty changes are authorized for discard', async () => {
    const result = await prepareLegacyWorktreeExit(
      { callerSessionId: 'caller-sid', discardChanges: true },
      {
        runGit: queuedGit([], ['/repo/.git', 'detached-sha', '']),
        exists: () => true,
        realpath: (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        callerCwd: () => '/repo',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('not reachable from any local branch');
    expect(result.hint).toContain('Create a local branch or tag');
    expect(result.hint).toContain(
      'discardChanges does not authorize losing commits',
    );
    expect(result.markerCleared).toBe(false);
  });

  it('rejects an explicit path that differs from the caller marker before Git', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const realpaths: string[] = [];
    const result = await prepareLegacyWorktreeExit(
      {
        callerSessionId: 'caller-sid',
        worktreePathOverride: '/repo/.agent-deck/worktrees/other',
      },
      {
        runGit: queuedGit(calls, []),
        exists: () => true,
        realpath: (p) => {
          realpaths.push(p);
          return p;
        },
        callerMarker: () => '/repo/.agent-deck/worktrees/test',
        callerCwd: () => '/repo',
        clearCwdReleaseMarker: () => undefined,
      },
    );

    expect(exitIsError(result)).toBe(true);
    if (!exitIsError(result)) return;
    expect(result.error).toContain('does not match caller marker');
    expect(calls).toEqual([]);
    expect(realpaths).toEqual([]);
  });

  it('clears a stale marker synchronously when the target is already absent', async () => {
    const cleared: string[] = [];
    const result = await prepareLegacyWorktreeExit(
      { callerSessionId: 'caller-sid' },
      {
        runGit: queuedGit([], []),
        exists: () => false,
        realpath: (p) => p,
        callerMarker: () => '/repo/.agent-deck/worktrees/missing',
        callerCwd: () => '/repo',
        clearCwdReleaseMarker: (sid) => {
          cleared.push(sid);
        },
      },
    );

    expect(result).toEqual({
      kind: 'missing',
      worktreePath: '/repo/.agent-deck/worktrees/missing',
      markerCleared: true,
    });
    expect(cleared).toEqual(['caller-sid']);
  });

  it('preflights a real detached worktree with default bounded Git and leaves it registered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-legacy-exit-'));
    const mainRepo = join(root, 'repo');
    const worktreePath = join(root, 'detached');
    try {
      mkdirSync(mainRepo);
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: mainRepo,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: mainRepo,
      });
      execFileSync('git', ['config', 'user.name', 'Agent Deck Test'], {
        cwd: mainRepo,
      });
      writeFileSync(join(mainRepo, 'tracked.txt'), 'baseline\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-m', 'baseline'], {
        cwd: mainRepo,
        stdio: 'ignore',
      });
      execFileSync(
        'git',
        ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
        { cwd: mainRepo, stdio: 'ignore' },
      );

      const result = await prepareLegacyWorktreeExit(
        { callerSessionId: 'caller-sid' },
        {
          callerMarker: () => worktreePath,
          callerCwd: () => worktreePath,
          clearCwdReleaseMarker: () => undefined,
        },
      );

      expect(exitIsError(result)).toBe(false);
      if (exitIsError(result)) return;
      expect(result).toMatchObject({
        kind: 'ready',
        originalCwd: realpathSync.native(mainRepo),
        mainRepo: realpathSync.native(mainRepo),
        worktreePath: realpathSync.native(worktreePath),
        headCommit: expect.any(String),
      });
      expect(existsSync(worktreePath)).toBe(true);
      expect(
        execFileSync('git', ['worktree', 'list', '--porcelain'], {
          cwd: mainRepo,
          encoding: 'utf8',
        }),
      ).toContain(realpathSync.native(worktreePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
