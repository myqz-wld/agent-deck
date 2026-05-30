/**
 * archive_plan impl REVIEW_33 H1 / H2 / H9 + plan 文件路径 fallback 单测
 * （CHANGELOG_105 拆分自 archive-plan.test.ts）。
 *
 * 范围：archivePlanImpl
 * - 默认 plan 路径 fallback（先 main-repo/.claude/plans/ → ~/.claude/plans/）
 * - REVIEW_33 H1：baseBranch checkout（rev-parse --verify + checkout）
 * - REVIEW_33 H2：status 三档分流（abandoned / unknown / 缺 status）
 * - REVIEW_33 H9：post-ff-merge phase prefix
 *
 * 不真起 git / 不真碰 fs：deps inject 替换全部副作用（与 archive-plan.impl-core.test.ts 同款）。
 *
 * 其它范围：
 * - happy path / 预检失败 / H10 → archive-plan.impl-core.test.ts
 * - archivePlanHandler caller archive 三态 → archive-plan.handler.test.ts
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  archivePlanImpl,
  _isArchivePlanError,
} from '../tools/handlers/archive-plan-impl';
import type { ArchivePlanError } from '../tools/handlers/archive-plan-impl';
import { makeState, makeDeps, fixtureHappyPath } from './archive-plan/_setup';

describe('archivePlanImpl — plan 文件路径 fallback', () => {
  it('main-repo/.claude/plans 不存在 → fallback 到 ~/.claude/plans', async () => {
    const state = makeState();
    const planId = 'global-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/global-plan';
    const mainRepo = '/Users/test/repo';
    state.files.set(worktreePath, '__dir__'); // REVIEW_33 H10
    state.recognizedMainRepos.add(mainRepo); // B-HIGH-4 mainRepo status precheck 透明 mock
    const userGlobalPath = `${state.fakeHomedir}/.claude/plans/${planId}.md`;
    state.files.set(
      userGlobalPath,
      [
        '---',
        `plan_id: ${planId}`,
        'status: in_progress',
        '---',
        '',
        'body',
      ].join('\n'),
    );

    const deps = makeDeps(state, [
      `${mainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'h',
      '',
      '',
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(
      { planId, worktreePath, baseBranch: 'main' },
      deps,
    );

    expect(_isArchivePlanError(result)).toBe(false);
    // 删除的是 user-global 路径（fallback 命中）
    expect(state.unlinks).toContain(userGlobalPath);
  });

  it('显式 planFilePath override → 用之（覆盖默认 fallback）', async () => {
    const state = makeState();
    const planId = 'override-plan';
    // archive-plan-tool-ux-followup-20260515 HIGH-1 stem refine: customPath 文件名 stem 必须
    // 等于 planId,否则 step 5 拒绝(防 archived path / INDEX key 派生与 caller 给的文件 stem 脱节)。
    const customPath = `/Users/test/some-custom-location/${planId}.md`;
    state.files.set(
      customPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );
    const worktreePath = '/Users/test/repo/.claude/worktrees/override-plan';
    state.files.set(worktreePath, '__dir__'); // REVIEW_33 H10
    state.recognizedMainRepos.add('/Users/test/repo'); // B-HIGH-4 mainRepo status precheck 透明 mock

    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'wb',
      '',
      'mainhash',
      '',
      '',
      'h',
      '',
      '',
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(
      {
        planId,
        worktreePath,
        baseBranch: 'main',
        planFilePathOverride: customPath,
      },
      deps,
    );

    expect(_isArchivePlanError(result)).toBe(false);
    expect(state.unlinks).toContain(customPath);
  });

  it('显式 planFilePath override 不存在 → reject', async () => {
    const state = makeState();
    state.files.set('/Users/test/repo/.claude/worktrees/whatever', '__dir__'); // REVIEW_33 H10
    state.recognizedMainRepos.add('/Users/test/repo'); // B-HIGH-4 mainRepo status precheck 透明 mock
    const deps = makeDeps(state, ['/Users/test/repo/.git', 'wb', '']);

    const result = await archivePlanImpl(
      {
        planId: 'whatever',
        worktreePath: '/Users/test/repo/.claude/worktrees/whatever',
        baseBranch: 'main',
        planFilePathOverride: '/no/such/path.md',
      },
      deps,
    );
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('planFilePath override does not exist');
  });
});

describe('archivePlanImpl — REVIEW_33 H1 baseBranch checkout', () => {
  it('baseBranch 真切：调用顺序含 rev-parse --verify <baseBranch> + checkout <baseBranch>', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    // 用 develop 作 baseBranch（与 default 'main' 区分），确认 impl 真用 input.baseBranch
    const customInput = { ...input, baseBranch: 'develop' };
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix-20260513',
      '',
      'develophash', // rev-parse --verify develop 真返 hash
      '', // checkout develop
      '', // merge --ff-only
      'h',
      '',
      '',
      'archivehash', // REVIEW_56 Batch B R1 MED-1: archive-rev-parse-HEAD
      '',
      '',
    ]);

    const result = await archivePlanImpl(customInput, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 1 Step 1.2 修法 (B-HIGH-3): args 改为
    // ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`] 让校验严格落 refs/heads/
    // namespace 不接受 SHA / tag / detached HEAD。
    expect(state.gitCalls[3]?.args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/develop',
    ]);
    expect(state.gitCalls[4]?.args).toEqual(['checkout', 'develop']);
    expect(state.gitCalls[4]?.cwd).toBe(expectedMainRepo);
    expect(state.gitCalls[5]?.args).toEqual(['merge', '--ff-only', 'worktree-mcp-bug-fix-20260513']);
  });

  it('baseBranch 不存在 → rev-parse --verify refs/heads/<branch> throw → reject 提示 baseBranch 不是 named branch', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `/Users/test/repo/.git`,
      'wb',
      '',
      new Error('fatal: Needed a single revision'),
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 1 Step 1.2 修法 (B-HIGH-3):
    // 措辞从 "does not exist" 改为 "is not a named branch (refs/heads/<name>); SHA / tag /
    // detached HEAD refs are not allowed." — 同时 hint 提示 archive_plan ff-merge 要求
    // 命名 branch、不接受 SHA / tag / detached HEAD。
    expect((result as ArchivePlanError).error).toContain('baseBranch "main"');
    expect((result as ArchivePlanError).error).toContain('not a named branch');
    expect((result as ArchivePlanError).error).toContain('refs/heads/');
    // checkout / merge 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'checkout')).toBeUndefined();
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('checkout baseBranch 失败 → reject + hint 提示 hooks/uncommitted', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `/Users/test/repo/.git`,
      'wb',
      '',
      'mainhash',
      new Error('error: Your local changes to the following files would be overwritten'),
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('git checkout main failed');
    expect((result as ArchivePlanError).hint).toContain('uncommitted changes');
    // merge 不应被调用（已早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });
});

describe('archivePlanImpl — REVIEW_33 H2 status 三档分流（abandoned / unknown / 缺 status）', () => {
  // 与 main Phase A4 / R1 deep review MED-3 共识：abandoned 不应入项目 git；非 in_progress
  // 一律 reject。expect 对齐 main impl 的措辞（merge 时双方 review 收敛到 main 版本）。
  it('plan status = abandoned → reject + hint 引用 user CLAUDE.md §Step 4 中止流程', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        `worktree_path: ${input.worktreePath}`,
        'status: abandoned',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('"abandoned"');
    expect((result as ArchivePlanError).error).toContain('must not be archived as completed');
    expect((result as ArchivePlanError).hint).toContain('§Step 4');
    expect((result as ArchivePlanError).hint).toContain('git worktree remove --force');
    expect((result as ArchivePlanError).hint).toContain('git branch -D');
    // git merge / checkout 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
    expect(state.gitCalls.find((c) => c.args[0] === 'checkout')).toBeUndefined();
  });

  it('plan status = unknown 值（如 draft） → reject + hint 引用三档 lifecycle', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        `worktree_path: ${input.worktreePath}`,
        'status: draft',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('"draft"');
    expect((result as ArchivePlanError).error).toContain('must be "in_progress"');
    expect((result as ArchivePlanError).hint).toContain('in_progress');
    expect((result as ArchivePlanError).hint).toContain('completed');
    expect((result as ArchivePlanError).hint).toContain('abandoned');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('plan frontmatter 缺 status 字段 → reject (status 视为 unknown，error 含 <missing>)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        `worktree_path: ${input.worktreePath}`,
        // 故意缺 status 行
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('<missing>');
    expect((result as ArchivePlanError).error).toContain('must be "in_progress"');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });
});

describe('archivePlanImpl — REVIEW_33 H9 post-ff-merge phase prefix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rev-parse HEAD (step 8) 失败 → error 含 [post-ff-merge:rev-parse-HEAD] + 专用 phaseHint(followup 20260515 (d))', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash', // rev-parse --verify base
      '', // checkout base
      '', // merge --ff-only ✅ ff 已成功
      new Error('fatal: bad revision HEAD'), // rev-parse HEAD ❌ post-ff-merge step 1 失败
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('[post-ff-merge:rev-parse-HEAD]');
    expect((result as ArchivePlanError).error).toContain('bad revision HEAD');
    // followup 20260515 (d):rev-parse-HEAD phase 现在有专用 phaseHint 而非通用 GENERIC。
    // 期望 hint 含具体 manual recovery 指引(rev-parse HEAD command + complete steps 9-14)。
    expect((result as ArchivePlanError).hint).toContain('rev-parse HEAD');
    expect((result as ArchivePlanError).hint).toContain('complete steps 9-14 manually');
  });

  it('git add (step 13a) 失败 → error 含 [post-ff-merge:git-add]', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '', // checkout
      '', // merge --ff-only
      'finalhash', // rev-parse HEAD ✅
      new Error('error: pathspec did not match any files'), // git add ❌
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('[post-ff-merge:git-add]');
    expect((result as ArchivePlanError).error).toContain('pathspec did not match');
  });

  it('git commit (step 13b) 失败 → error 含 [post-ff-merge:git-commit]', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
      '', // git add ✅
      new Error('hint: pre-commit hook rejected'), // git commit ❌
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('[post-ff-merge:git-commit]');
  });

  it('git worktree remove (step 14a) 失败 → 仍用 phase prefix 但 hint 是精细化版本（提示 --force）', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
      '',
      '', // git commit ✅
      'archivehash', // REVIEW_56 Batch B R1 MED-1: archive-rev-parse-HEAD ✅
      new Error('fatal: validation failed, cannot remove working tree'), // worktree remove ❌
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('[post-ff-merge:git-worktree-remove]');
    // phaseHint override 生效：精细化提示用 --force
    expect((result as ArchivePlanError).hint).toContain('--force');
    expect((result as ArchivePlanError).hint).toContain('git worktree remove');
    // 不会包含通用 hint（因为传了 phaseHint override）
    expect((result as ArchivePlanError).hint).not.toContain('main HEAD 已推进');
  });

  it('git branch -D (step 14b) 失败 → phase prefix + 精细化 hint（branch may already be deleted）', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
      '',
      '',
      'archivehash', // REVIEW_56 Batch B R1 MED-1: archive-rev-parse-HEAD ✅
      '', // worktree remove ✅
      new Error('error: branch not found'), // branch -D ❌
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('[post-ff-merge:git-branch-D]');
    expect((result as ArchivePlanError).hint).toContain('Branch may already be deleted');
  });

  it('pre-ff-merge 失败（如 baseBranch 不存在）→ error **不含** [post-ff-merge:] prefix（区分清楚 ff 前后）', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `/Users/test/repo/.git`,
      'wb',
      '',
      new Error('fatal: Needed a single revision'), // rev-parse --verify base ❌（pre-ff-merge）
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    // 关键：pre-ff-merge 失败的 error 不应含 [post-ff-merge:] prefix（caller 看到没有
    // prefix 知道 main 还没动 → 可以简单 retry）
    expect((result as ArchivePlanError).error).not.toContain('[post-ff-merge:');
    expect((result as ArchivePlanError).error).toContain('baseBranch');
  });
});

describe('archivePlanImpl — REVIEW_68 batch-3: plan frontmatter snake_case 读取（camelcase over-migration 回正）', () => {
  // commit 5ff0d78 误把 plan frontmatter 读取从 snake_case 迁到 camelCase，但 plan 文件实际写
  // snake_case（CHANGELOG_177 合法保留 + 所有归档 plan 实证）。导致 snake-only plan 的 cross-check
  // 静默失效（fm.worktreePath 恒 undefined → 走「字段缺失」warning 分支）+ base_branch fallback 失效。
  // 本组用 snake-only fixture 验证读 snake key 回正后守门 / fallback 重新生效。

  it('snake-only frontmatter worktree_path 与 input.worktreePath 不一致 → cross-check 触发 reject', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    const wrongWorktree = '/Users/test/repo/.claude/worktrees/WRONG-other-plan';
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        `worktree_path: ${wrongWorktree}`, // ← 故意 != input.worktreePath
        'status: in_progress',
        'base_branch: main',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('worktree_path mismatch');
    // silent-corruption 守门生效 → 绝不能 ff-merge / checkout（CHANGELOG_169 F2 防线）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
    expect(state.gitCalls.find((c) => c.args[0] === 'checkout')).toBeUndefined();
  });

  it('snake-only frontmatter plan_id 与 input.planId 不一致 → cross-check 触发 reject', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        'plan_id: some-other-plan-id', // ← 故意 != input.planId
        `worktree_path: ${input.worktreePath}`,
        'status: in_progress',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('plan_id mismatch');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('snake-only frontmatter base_branch (input 不传 baseBranch) → ff-merge checkout fm.base_branch 而非默认 main', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        `worktree_path: ${input.worktreePath}`,
        'status: in_progress',
        'base_branch: feature-x', // ← snake base_branch；input 不传 baseBranch 时应 fallback 到此
        '---',
        '',
        'body',
      ].join('\n'),
    );
    // 全 happy-path git 序列（镜像本文件「fallback 到 ~/.claude/plans」测试）
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`, // rev-parse --git-common-dir
      'wb', // worktree branch
      '', // worktree status
      'fxhash', // rev-parse --verify refs/heads/feature-x（branch 存在）
      '', // checkout feature-x
      '', // merge --ff-only wb
      'h', // rev-parse HEAD finalCommit
      '',
      '',
      'archivehash',
      '',
      '',
    ]);

    // 关键：input 省略 baseBranch → 应读 frontmatter base_branch=feature-x（camelCase over-migration
    // 时 fm.baseBranch undefined → 无脑 fallback main，feature-branch plan 会污染主线）
    const result = await archivePlanImpl(
      { planId: input.planId, worktreePath: input.worktreePath },
      deps,
    );
    const checkout = state.gitCalls.find((c) => c.args[0] === 'checkout');
    expect(checkout?.args[1]).toBe('feature-x'); // 合到 feature-x 而非 main
    expect(_isArchivePlanError(result)).toBe(false);
  });
});

