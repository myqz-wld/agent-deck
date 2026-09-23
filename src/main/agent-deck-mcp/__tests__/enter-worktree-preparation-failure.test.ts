import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerResult } from '../tools/helpers';
import { rollbackPreparedWorktree } from '../tools/handlers/enter-worktree-impl';

const harness = vi.hoisted(() => ({
  reserve: vi.fn(() => 'enter-tool'),
  release: vi.fn(),
  createEnter: vi.fn(() => { throw new Error('unexpected worktree creation'); }),
  bind: vi.fn(),
  arm: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: () => ({ id: 'caller', cwd: '/repo', lifecycle: 'active' }) },
}));
vi.mock('@main/store/agent-deck-team-repo', () => ({ agentDeckTeamRepo: {} }));
vi.mock('@main/session/hand-off/ownership', () => ({
  sessionOwnershipLineage: vi.fn(),
  sessionOwnershipLineages: vi.fn(),
}));
vi.mock('@main/store/worktree-transition-repo', () => ({
  WorktreeTransitionConflictError: class extends Error {},
  worktreeTransitionRepo: { get: () => null, createEnter: harness.createEnter },
}));
vi.mock('@main/session/worktree-transition/coordinator', () => ({
  worktreeTransitionCoordinator: {
    reserveToolInvocation: harness.reserve,
    releaseToolInvocation: harness.release,
    bindToolInvocation: harness.bind,
    arm: harness.arm,
  },
}));

import { enterWorktreeHandler } from '../tools/handlers/enter-worktree';

const ctx = { caller: { callerSessionId: 'caller', transport: 'in-process' as const } };
const args = { startPoint: 'HEAD', worktreePath: '/worktrees/task' };

function makeDeps() {
  return {
    callerCwd: () => '/repo',
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => {}),
    runGit: vi.fn(async (command: string[]) => {
      if (command[0] === 'worktree' && command[1] === 'list') return 'worktree /repo\0\0';
      if (command.includes('--show-toplevel')) return '/repo';
      if (command.includes('HEAD^{commit}')) return 'a'.repeat(40);
      throw new Error('unexpected Git mutation');
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('enter worktree preparation failures', () => {
  it.each(['exists', 'mkdir'] as const)(
    'bounds a stalled %s and never creates a worktree after late completion',
    async (operation) => {
      const deps = makeDeps();
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => { finish = resolve; });
      if (operation === 'exists') deps.exists.mockImplementation(async () => { await stalled; return false; });
      else deps.mkdir.mockImplementation(() => stalled);

      let result: HandlerResult | undefined;
      const pending = enterWorktreeHandler(args, ctx, { implDeps: deps }).then((value) => { result = value; });
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(result?.isError).toBe(true);
        const body = JSON.parse(result!.content[0]!.text);
        expect(body.error).toContain('timed out');
        expect(body.error).toContain(operation === 'exists' ? 'path check' : 'parent directory');
        expect(harness.release).toHaveBeenCalledWith('caller', 'enter-tool');
        expect(harness.createEnter).not.toHaveBeenCalled();
        expect(harness.arm).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        finish();
        await pending;
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.createEnter).not.toHaveBeenCalled();
        expect(deps.runGit.mock.calls.every(([command]) => command[1] !== 'add')).toBe(true);
        if (operation === 'exists') expect(deps.mkdir).not.toHaveBeenCalled();
      } finally {
        finish();
        await pending;
      }
    },
  );

  it('returns a preparation error and releases the invocation when mkdir rejects', async () => {
    const deps = makeDeps();
    deps.mkdir.mockRejectedValue(new Error('EACCES: parent unavailable'));

    const result = await enterWorktreeHandler(args, ctx, { implDeps: deps });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toContain('EACCES');
    expect(harness.release).toHaveBeenCalledWith('caller', 'enter-tool');
    expect(harness.createEnter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports incomplete rollback if path inspection stalls and never removes it later', async () => {
    let finish!: (exists: boolean) => void;
    const exists = new Promise<boolean>((resolve) => { finish = resolve; });
    const runGit = vi.fn(async () => '');
    let warnings: string[] | undefined;
    const pending = rollbackPreparedWorktree({
      callerSessionId: 'caller',
      originalCwd: '/repo',
      mainRepo: '/repo',
      worktreePath: args.worktreePath,
      startCommit: 'a'.repeat(40),
    }, { exists: () => exists, runGit }).then((value) => { warnings = value; });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(warnings?.[0]).toContain('path check');
      expect(warnings?.[0]).toContain('timed out');
      expect(runGit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      finish(true);
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(runGit).not.toHaveBeenCalled();
    } finally {
      finish(false);
      await pending;
    }
  });
});
