import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createPreparedWorktree,
  prepareEnterWorktree,
  rollbackPreparedWorktree,
  _internalIsError as enterIsError,
  type EnterWorktreeDeps,
} from '../tools/handlers/enter-worktree-impl';

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

describe('detached worktree preparation', () => {
  it('freezes startPoint and creates a detached worktree without branch commands', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const mkdirs: string[] = [];
    const startCommit = 'a'.repeat(40);
    const deps: EnterWorktreeDeps = {
      runGit: queuedGit(calls, [
        'worktree /repo\0HEAD main-head\0\0',
        '/repo',
        startCommit,
        '',
      ]),
      exists: async () => false,
      mkdir: async (p) => {
        mkdirs.push(p);
      },
      callerCwd: () => '/repo/src',
      now: () => 1,
    };
    const result = await prepareEnterWorktree(
      {
        callerSessionId: 'caller-sid',
        startPoint: 'main~1',
        worktreeRootOverride: '/repo/.agent-deck/worktrees',
      },
      deps,
    );

    expect(enterIsError(result)).toBe(false);
    if (enterIsError(result)) return;
    expect(result).toMatchObject({
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/agent-deck-caller-sid-1',
      startCommit,
    });
    await createPreparedWorktree(result, deps);
    expect(mkdirs).toEqual(['/repo/.agent-deck/worktrees']);
    expect(calls.map((c) => c.args)).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'main~1^{commit}',
    ]);
    expect(calls.find((call) => call.args.includes('main~1^{commit}'))?.cwd).toBe('/repo/src');
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
    const result = await prepareEnterWorktree(
      { callerSessionId: 'caller-sid', startPoint: 'main branch' },
      {
        runGit: queuedGit(calls, ['worktree /repo\0HEAD main-head\0\0', '/repo']),
        exists: async () => false,
        mkdir: async () => undefined,
        callerCwd: () => '/repo',
      },
    );

    expect(enterIsError(result)).toBe(true);
    if (!enterIsError(result)) return;
    expect(result.error).toContain('startPoint must be one non-empty Git revision');
    expect(calls.map((call) => call.args)).toEqual([
      ['worktree', 'list', '--porcelain', '-z'],
      ['rev-parse', '--show-toplevel'],
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

      const result = await prepareEnterWorktree(
        {
          callerSessionId: 'caller-sid',
          startPoint: 'HEAD',
          worktreePathOverride: worktreePath,
        },
        {
          callerCwd: () => mainRepo,
        },
      );

      expect(enterIsError(result)).toBe(false);
      if (enterIsError(result)) return;
      await createPreparedWorktree(result);
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
