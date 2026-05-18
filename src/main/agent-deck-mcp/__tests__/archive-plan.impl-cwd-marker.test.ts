/**
 * archive-plan-impl cwd 4 态分流单测（plan codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * 范围: archivePlanImpl §step 4 cwd 4 态预检（不变量 5 + D2 修法）:
 * - 状态 1 (!inWorktree)                     → 放过（claude builtin 路径不变）
 * - 状态 2 (inWorktree + marker == worktree) → 放过（codex / 跨 adapter mcp 路径）
 * - 状态 3 (inWorktree + marker == null)     → reject（claude builtin 忘 ExitWorktree）
 * - 状态 4 (inWorktree + marker != worktree) → reject（跨 worktree archive 不允许）
 *
 * 不真起 git / 不真碰 fs / 不真碰 DB: deps inject 替换全部副作用（与 archive-plan.impl-core.test.ts
 * 同款 deps inject 模式; cwdReleaseMarker dep 是 plan 本次新加 seam）。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { archivePlanImpl, _isArchivePlanError } from '../tools/handlers/archive-plan-impl';
import type {
  ArchivePlanResult,
  ArchivePlanError,
  ArchivePlanDeps,
} from '../tools/handlers/archive-plan-impl';
import { makeState, makeDeps, fixtureHappyPath } from './archive-plan/_setup';

/**
 * 包装 makeDeps 加 cwdReleaseMarker dep（_setup makeDeps 不含此字段,本 test 专用补丁）。
 * marker = null → 走「无 marker」分支 (状态 1 / 状态 3)
 * marker = string → 走「持 marker」分支 (状态 2 / 状态 4)
 */
function makeDepsWithMarker(
  state: ReturnType<typeof makeState>,
  gitMockPlan: Array<string | Error>,
  marker: string | null,
): ArchivePlanDeps {
  return {
    ...makeDeps(state, gitMockPlan),
    cwdReleaseMarker: () => marker,
  };
}

describe('archivePlanImpl — cwd 4 态分流 (plan codex-handoff-team-alignment-20260518 §step 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── TC6: 状态 1 ─ caller 不在 worktree + 无 marker → 放过 ─────────────────────
  it('TC6 状态 1: !inWorktree + marker=null → 放过 (claude builtin 路径不变)', async () => {
    const { state, input } = fixtureHappyPath();
    // fakeCwd default '/Users/test/some-other-cwd' 已在 worktree 外
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git', // rev-parse --git-common-dir
        'worktree-mcp-bug-fix',  // rev-parse --abbrev-ref HEAD
        '',                       // status --porcelain clean
        'mainhash',               // rev-parse --verify baseBranch
        '',                       // checkout baseBranch
        '',                       // merge --ff-only
        'finalhash',              // rev-parse HEAD
        '',                       // add
        '',                       // commit
        '',                       // worktree remove
        '',                       // branch -D
      ],
      null, // marker=null
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).commitHash).toBe('finalhash');
  });

  // ─── TC7: 状态 2 ─ caller 在 worktree + marker == worktreePath → 放过 ─────────
  it('TC7 状态 2: inWorktree + marker == worktreePath → 放过 (codex / 跨 adapter mcp 路径)', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = `${input.worktreePath}/src/main/foo.ts`; // cwd 在 worktree 内
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git', // rev-parse --git-common-dir
        'worktree-mcp-bug-fix',  // rev-parse --abbrev-ref HEAD
        '',                       // status --porcelain clean
        'mainhash',               // rev-parse --verify baseBranch
        '',                       // checkout baseBranch
        '',                       // merge --ff-only
        'finalhash',              // rev-parse HEAD
        '',                       // add
        '',                       // commit
        '',                       // worktree remove
        '',                       // branch -D
      ],
      input.worktreePath, // marker == worktreePath
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).commitHash).toBe('finalhash');
  });

  // ─── TC8: 状态 3 ─ caller 在 worktree + marker=null → reject ──────────────────
  it('TC8 状态 3: inWorktree + marker=null → reject (claude builtin 但忘 ExitWorktree)', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = `${input.worktreePath}/src/main/foo.ts`; // cwd 在 worktree 内
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git', // rev-parse --git-common-dir
        'worktree-mcp-bug-fix',  // rev-parse --abbrev-ref HEAD
        '',                       // status --porcelain clean，预检通过到 cwd 检查
      ],
      null, // marker=null
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('inside the worktree');
    expect(err.error).toContain('no enter_worktree marker held');
    expect(err.hint).toContain('ExitWorktree first');
    expect(err.hint).toContain('mcp enter_worktree');
  });

  // ─── TC9: 状态 4 ─ caller 在 worktree + marker != worktreePath → reject ───────
  it('TC9 状态 4: inWorktree + marker != worktreePath → reject (跨 worktree archive 不允许)', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = `${input.worktreePath}/src/main/foo.ts`; // cwd 在 worktree 内
    const wrongMarker = '/Users/test/repo/.claude/worktrees/some-other-plan';
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git', // rev-parse --git-common-dir
        'worktree-mcp-bug-fix',  // rev-parse --abbrev-ref HEAD
        '',                       // status --porcelain clean，预检通过到 cwd 检查
      ],
      wrongMarker, // marker != worktreePath
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('inside worktree');
    expect(err.error).toContain('different worktree');
    expect(err.error).toContain(wrongMarker);
    expect(err.hint).toContain('Cross-worktree archive is not allowed');
  });

  // ─── TC10: marker realpath 对齐 worktreeReal (symlink 防 false-negative) ──────
  it('TC10 状态 2 边角: marker 与 worktreePath 物理同路径但字面 symlink 不同 → realpath 对齐放过', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = `${input.worktreePath}/src/main/foo.ts`;
    // 模拟 symlink:input.worktreePath='/Users/test/repo/.claude/worktrees/mcp-bug-fix-20260513'
    // marker 是 symlink '/var/sym/wt' 解析到同一物理路径
    const symMarker = '/var/sym/wt';
    state.realpathMap.set(symMarker, input.worktreePath);
    state.realpathMap.set(input.worktreePath, input.worktreePath);
    state.realpathMap.set(state.fakeCwd, state.fakeCwd);
    // 但 cwd realpath 也需对齐 worktreePath subtree
    state.realpathMap.set(state.fakeCwd, `${input.worktreePath}/src/main/foo.ts`);
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git',
        'worktree-mcp-bug-fix',
        '',
        'mainhash',
        '',
        '',
        'finalhash',
        '',
        '',
        '',
        '',
      ],
      symMarker,
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).commitHash).toBe('finalhash');
  });
});
