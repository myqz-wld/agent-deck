/**
 * archive-plan-impl cwd 4 态分流单测（plan codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * 范围 (P5 Round 1 reviewer-codex HIGH-1 修法后): archivePlanImpl §step 4 cwd 4 态预检
 * 完整覆盖 plan §不变量 5 (cwd valid/invalid × marker null/match/mismatch):
 *
 * **cwd valid 子分流** (existing TC6-10, inWorktree sub-discriminator):
 * - TC6 状态 (a) cwd valid + !inWorktree + marker=null → 放过 (claude builtin 路径不变)
 * - TC7 状态 (剧 inWorktree 子) cwd valid + inWorktree + marker == worktree → 放过 + release marker
 * - TC8 状态 (剧 inWorktree 子) cwd valid + inWorktree + marker == null → reject (claude builtin 忘 ExitWorktree)
 * - TC9 状态 (剧 inWorktree 子) cwd valid + inWorktree + marker != worktree → reject (跨 worktree)
 * - TC10 状态 2 symlink 边角: marker realpath 对齐 worktreeReal
 *
 * **cwd invalid 子分流** (P5 Round 1 新加 TC11-14, plan §不变量 5 (b) (c) (d)):
 * - TC11 状态 (b) cwd invalid + marker == worktreeReal → 放过 + release marker (codex worktree 被外部删兜底)
 * - TC12 状态 (d) cwd invalid + marker == null → reject (cwd resilience guard rail)
 * - TC13 状态 (d) cwd invalid + marker != worktree → reject (confused state)
 * - TC14 状态 (c) cwd valid + !inWorktree + marker present → warn + 放过 + release (caller 移走 cwd 但忘 exit_worktree)
 *
 * 不真起 git / 不真碰 fs / 不真碰 DB: deps inject 替换全部副作用（与 archive-plan.impl-core.test.ts
 * 同款 deps inject 模式; cwdReleaseMarker / clearCwdReleaseMarker dep 是 plan 本次新加 seam）。
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
 * 包装 makeDeps 加 cwdReleaseMarker / clearCwdReleaseMarker dep（_setup makeDeps 不含此字段,本 test 专用补丁）。
 * marker = null → 走「无 marker」分支
 * marker = string → 走「持 marker」分支
 * P5 Round 1 reviewer-codex HIGH-1 修法 (release marker seam):
 * 同步加 clearCwdReleaseMarker spy,记录是否被调以验证 releaseMarkerOnSuccess 路径。
 */
function makeDepsWithMarker(
  state: ReturnType<typeof makeState>,
  gitMockPlan: Array<string | Error>,
  marker: string | null,
): ArchivePlanDeps & { clearMarkerCalled: { count: number } } {
  const counter = { count: 0 };
  return {
    ...makeDeps(state, gitMockPlan),
    cwdReleaseMarker: () => marker,
    clearCwdReleaseMarker: async () => {
      counter.count += 1;
    },
    clearMarkerCalled: counter,
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
    // P5 Round 1 reviewer-claude LOW-6 修法 (TC10 setup 删 duplicate set):
    // 旧实现 line 158 + line 160 双 set state.fakeCwd → 同 key 两次 set 第二次覆盖第一次,
    // 测试意图模糊 (line 160 identity map 实际等价 noop)。改为单次 set 让 cwd subtree
    // realpath 解析正确( cwd 在 worktree 内子目录,realpath 解析后仍 startsWith worktreeReal)。
    const symMarker = '/var/sym/wt';
    state.realpathMap.set(symMarker, input.worktreePath);
    state.realpathMap.set(input.worktreePath, input.worktreePath);
    state.realpathMap.set(state.fakeCwd, state.fakeCwd);
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
    // P5 Round 1 reviewer-codex HIGH-1 修法 (release marker seam):状态 2 (持 marker) 必 release
    expect(deps.clearMarkerCalled.count).toBe(1);
  });

  // ─── TC11-14: cwd invalid 子分流 (P5 Round 1 reviewer-codex HIGH-1 修法新增) ────────

  // ─── TC11: cwd invalid + marker == worktreeReal → 放过 + release ─────────
  it('TC11 状态 (b): cwd invalid + marker == worktreeReal → 放过 + release marker (worktree 被外部删兜底)', async () => {
    const { state, input } = fixtureHappyPath();
    // 模拟 caller cwd 失效:realpathMap 不为 fakeCwd 设置 → realpath fallback 抛 ENOENT
    state.fakeCwd = '/Users/test/some/deleted/path';
    // 显式让 realpath 抛错触发 cwd invalid 分支
    state.realpathMap.set(input.worktreePath, input.worktreePath);
    // fakeCwd 不在 realpathMap → makeDeps fallback 检查 fs (但 mock 无此路径 → throw)
    const realpathSpy = vi.fn(async (p: string) => {
      if (p === '/Users/test/some/deleted/path') {
        throw new Error('ENOENT: no such file or directory');
      }
      return state.realpathMap.get(p) ?? p;
    });
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
      input.worktreePath, // marker == worktreePath
    );
    deps.realpath = realpathSpy;

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).commitHash).toBe('finalhash');
    // 必 release marker (cwd invalid + marker valid 兜底)
    expect(deps.clearMarkerCalled.count).toBe(1);
  });

  // ─── TC12: cwd invalid + marker == null → reject (state d) ─────────────
  it('TC12 状态 (d): cwd invalid + marker == null → reject (cwd resilience guard rail)', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = '/Users/test/some/deleted/path';
    state.realpathMap.set(input.worktreePath, input.worktreePath);
    const realpathSpy = vi.fn(async (p: string) => {
      if (p === '/Users/test/some/deleted/path') {
        throw new Error('ENOENT: no such file or directory');
      }
      return state.realpathMap.get(p) ?? p;
    });
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git',
        'worktree-mcp-bug-fix',
        '',
      ],
      null,
    );
    deps.realpath = realpathSpy;

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('caller cwd');
    expect(err.error).toContain('invalid');
    expect(err.error).toContain('no enter_worktree marker held');
    expect(err.hint).toContain('cwd resilience guard rail');
    expect(err.hint).toContain('Restart the caller session');
    // reject 路径不应 release marker
    expect(deps.clearMarkerCalled.count).toBe(0);
  });

  // ─── TC13: cwd invalid + marker != worktree → reject (state d alt) ──────
  it('TC13 状态 (d) alt: cwd invalid + marker != worktree → reject (confused state)', async () => {
    const { state, input } = fixtureHappyPath();
    const wrongMarker = '/Users/test/repo/.claude/worktrees/some-other-plan';
    state.fakeCwd = '/Users/test/some/deleted/path';
    state.realpathMap.set(input.worktreePath, input.worktreePath);
    state.realpathMap.set(wrongMarker, wrongMarker);
    const realpathSpy = vi.fn(async (p: string) => {
      if (p === '/Users/test/some/deleted/path') {
        throw new Error('ENOENT: no such file or directory');
      }
      return state.realpathMap.get(p) ?? p;
    });
    const deps = makeDepsWithMarker(
      state,
      [
        '/Users/test/repo/.git',
        'worktree-mcp-bug-fix',
        '',
      ],
      wrongMarker,
    );
    deps.realpath = realpathSpy;

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('caller cwd');
    expect(err.error).toContain('invalid');
    expect(err.error).toContain('does not match worktree_path');
    expect(err.hint).toContain('cwd resilience guard rail');
    expect(err.hint).toContain('exit_worktree');
    expect(err.hint).toContain(wrongMarker);
    expect(deps.clearMarkerCalled.count).toBe(0);
  });

  // ─── TC14: cwd valid + !inWorktree + marker present → warn + 放过 + release ─
  it('TC14 状态 (c): cwd valid + !inWorktree + marker present → warn + 放过 + release', async () => {
    const { state, input } = fixtureHappyPath();
    // fakeCwd default '/Users/test/some-other-cwd' 已在 worktree 外 (cwd valid)
    // 但 caller 仍持 marker (没调 exit_worktree 就移开 cwd)
    const staleMarker = input.worktreePath;
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
      staleMarker,
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    const ok = result as ArchivePlanResult;
    expect(ok.commitHash).toBe('finalhash');
    // warning 应记录 stale marker 提示
    expect(ok.warnings.some((w) => w.includes('outside worktree') && w.includes('marker'))).toBe(
      true,
    );
    // 必 release marker (state c-1 也 release,与 plan §不变量 5 (c) "cwd 优先 + release stale" 一致)
    expect(deps.clearMarkerCalled.count).toBe(1);
  });

  // ─── TC15 (plan §Phase 3 Step 3.7 修法 B-MED-1 claude): cwd valid + !inWorktree +
  //         marker 指向另一 worktree → 仅 warn 不 release (拒绝跨 worktree release 别人 marker) ─
  it('TC15 状态 (c-2): cwd valid + !inWorktree + marker 指向另一 worktree → warn + 放过但不 release', async () => {
    const { state, input } = fixtureHappyPath();
    // fakeCwd default '/Users/test/some-other-cwd' 已在 worktree 外 (cwd valid)
    // marker 指向另一个 worktree(不是当前 archive 目标),不应被 release(让 caller 自己
    // exit_worktree 清自己的 marker)。
    const otherWorktreeMarker = '/Users/test/repo/.claude/worktrees/some-other-plan';
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
      otherWorktreeMarker,
    );

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    const ok = result as ArchivePlanResult;
    expect(ok.commitHash).toBe('finalhash');
    // warning 应提示 marker 指向另一 worktree + 不 release
    expect(
      ok.warnings.some(
        (w) =>
          w.includes('outside worktree') &&
          w.includes('different worktree') &&
          w.includes(otherWorktreeMarker),
      ),
    ).toBe(true);
    // 关键 assertion: 不可 release 别人 worktree 的 marker (跨 worktree release 拒绝)
    expect(deps.clearMarkerCalled.count).toBe(0);
  });
});
