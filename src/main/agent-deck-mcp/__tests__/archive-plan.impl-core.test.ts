/**
 * archive_plan impl 核心覆盖单测（CHANGELOG_105 拆分自 archive-plan.test.ts）。
 *
 * 范围：archivePlanImpl
 * - happy path 完整调用链
 * - 预检失败分支：plan completed / cwd 在 worktree / worktree dirty / detached HEAD
 * - REVIEW_33 H10：worktreePath 存在性预检
 *
 * 不真起 git / 不真碰 fs：deps inject 替换全部副作用，跑纯 in-memory（与 tools.test.ts
 * 风格一致；deps inject 比 vi.mock 更内聚 + 灵活）。
 *
 * 其它范围：
 * - 路径 fallback / REVIEW_33 H1 H2 H9 → archive-plan.impl-r33.test.ts
 * - archivePlanHandler caller archive 三态 → archive-plan.handler.test.ts
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  archivePlanImpl,
  _isArchivePlanError,
} from '../tools/handlers/archive-plan-impl';
import type { ArchivePlanResult, ArchivePlanError } from '../tools/handlers/archive-plan-impl';
import { makeState, makeDeps, fixtureHappyPath } from './archive-plan/_setup';

describe('archivePlanImpl — happy path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('完整 happy path：git/fs 调用顺序 + frontmatter 更新 + INDEX 创建 + 返回结构', async () => {
    const { state, input, expectedMainRepo, expectedArchivedPath } = fixtureHappyPath();
    // git 调用顺序（按 impl 内 runGit 调用顺序，REVIEW_33 H1 在 step 7 前加 verify + checkout）：
    //   1. rev-parse --git-common-dir → /Users/test/repo/.git
    //   2. rev-parse --abbrev-ref HEAD → "worktree-mcp-bug-fix"
    //   3. status --porcelain → "" (clean)
    //   4. rev-parse --verify <baseBranch> → "<hash>" (verify exists, REVIEW_33 H1)
    //   5. checkout <baseBranch> → "" (REVIEW_33 H1)
    //   6. merge --ff-only worktree-mcp-bug-fix → "" (or any stdout)
    //   7. rev-parse HEAD → "deadbeef123"
    //   8. add <files...> → ""
    //   9. commit -m ... → ""
    //  10. worktree remove ... → ""
    //  11. branch -D worktree-mcp-bug-fix → ""
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'deadbeef123',
      '',
      '',
      '',
      '',
    ]);

    const result = await archivePlanImpl(input, deps);

    expect(_isArchivePlanError(result)).toBe(false);
    const ok = result as ArchivePlanResult;
    expect(ok.archivedPath).toBe(expectedArchivedPath);
    expect(ok.commitHash).toBe('deadbeef123');
    expect(ok.branchDeleted).toBe('worktree-mcp-bug-fix');
    expect(ok.worktreeRemoved).toBe(input.worktreePath);
    // archive-plan-tool-ux-followup-20260515 (b)+(c): plansIndexAppended boolean → plansIndexAction
    // 四态 enum。fixture INDEX 不存在 → action='created'。warnings 数组(HIGH-2 silent override warn)
    // happy path 应为空(plan 仅在 .claude/plans/ 不在 plans/,无双存)。
    expect(ok.plansIndexAction).toBe('created');
    expect(ok.warnings).toEqual([]);
    expect(ok.finalStatus).toBe('completed');

    // git 调用次数严格 11 次（happy path 完整，REVIEW_33 H1 加了 verify + checkout）
    expect(state.gitCalls.length).toBe(11);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
    expect(state.gitCalls[0]?.cwd).toBe(input.worktreePath);
    // REVIEW_33 H1：verify base_branch 存在 + checkout 到 base_branch
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 1 Step 1.2 修法 (B-HIGH-3): args 改为
    // ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`] 让校验严格落 refs/heads/
    // namespace 不接受 SHA / tag / detached HEAD。
    expect(state.gitCalls[3]?.args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/main',
    ]);
    expect(state.gitCalls[3]?.cwd).toBe(expectedMainRepo);
    expect(state.gitCalls[4]?.args).toEqual(['checkout', 'main']);
    expect(state.gitCalls[4]?.cwd).toBe(expectedMainRepo);
    // ff-merge 从 [3] 移到 [5]
    expect(state.gitCalls[5]?.args).toEqual(['merge', '--ff-only', 'worktree-mcp-bug-fix']);
    expect(state.gitCalls[5]?.cwd).toBe(expectedMainRepo);
    expect(state.gitCalls[8]?.args[0]).toBe('commit');
    expect(state.gitCalls[9]?.args).toEqual(['worktree', 'remove', input.worktreePath]);
    expect(state.gitCalls[10]?.args).toEqual(['branch', '-D', 'worktree-mcp-bug-fix']);

    // 写归档 plan：含新 frontmatter + body 保留
    const archivedWrite = state.writes.find((w) => w.path === expectedArchivedPath);
    expect(archivedWrite).toBeTruthy();
    expect(archivedWrite!.content).toContain('status: "completed"');
    expect(archivedWrite!.content).toContain('final_commit: "deadbeef123"');
    expect(archivedWrite!.content).toContain('completed_at: "2026-05-13"');
    expect(archivedWrite!.content).toContain('# Plan body content');

    // INDEX 创建（首次）
    const indexWrite = state.writes.find(
      (w) => w.path === path.join(expectedMainRepo, 'plans', 'INDEX.md'),
    );
    expect(indexWrite).toBeTruthy();
    expect(indexWrite!.content).toContain('# Plans 索引');
    expect(indexWrite!.content).toContain(`[${input.planId}.md]`);

    // 删除原 plan
    expect(state.unlinks).toContain(`${expectedMainRepo}/.claude/plans/${input.planId}.md`);
  });

  it('INDEX 已存在 + 不含本 plan_id → append 一行 4 列 row(plansIndexAction=appended)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    state.files.set(
      indexPath,
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [old-plan.md](old-plan.md) | completed | — | older |\n',
    );

    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wbranch',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
      '',
      '',
      '',
      '',
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).plansIndexAction).toBe('appended');

    const indexWrite = state.writes.find((w) => w.path === indexPath);
    expect(indexWrite).toBeTruthy();
    // 旧条目保留 + 新条目追加(4 列 row)
    expect(indexWrite!.content).toContain('[old-plan.md]');
    expect(indexWrite!.content).toContain(`[${input.planId}.md]`);
    // append 行必须 4 列(完整含 status=completed + changelog 列 + description 列)
    const newRowRegex = new RegExp(
      `\\| \\[${input.planId}\\.md\\]\\(${input.planId}\\.md\\) \\| completed \\| [^|]+ \\| [^|]+ \\|`,
    );
    expect(indexWrite!.content).toMatch(newRowRegex);
    // 没有重写 header(header 出现 1 次)
    expect((indexWrite!.content.match(/# Plans 索引/g) ?? []).length).toBe(1);
  });

  it('archive-plan-tool-ux-followup-20260515 (b)+(c): plan_id 已在 INDEX → smart update 4 列(plansIndexAction=updated,不再跳过)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    // caller 在 in_progress 阶段已经手工把 plan_id 行写进 INDEX(典型 stub 创建惯例)
    state.files.set(
      indexPath,
      `# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [${input.planId}.md](${input.planId}.md) | in_progress | — | stub:work in progress |\n`,
    );

    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'h',
      '',
      '',
      '',
      '',
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    // 旧契约「跳过 append + plansIndexAppended=false」已废,新契约 smart update updated
    expect((result as ArchivePlanResult).plansIndexAction).toBe('updated');

    // smart update 后 INDEX 应有 1 次 write(updated 行)
    const indexWrites = state.writes.filter((w) => w.path === indexPath);
    expect(indexWrites.length).toBe(1);
    // status 列被改成 'completed'(原 'in_progress' 替换)
    expect(indexWrites[0].content).toContain('| completed |');
    expect(indexWrites[0].content).not.toMatch(/\| in_progress \|/);
    // 旧 description 列被替换为 freshFm(fixture 无 description → fallback 到 plan_id)
    // 反向守门:'stub:work in progress' 老 description 被覆盖
    expect(indexWrites[0].content).not.toContain('stub:work in progress');
    // 行格式必须 4 列 canonical
    const rewrittenRowRegex = new RegExp(
      `\\| \\[${input.planId}\\.md\\]\\(${input.planId}\\.md\\) \\| completed \\| [^|]+ \\| [^|]+ \\|`,
    );
    expect(indexWrites[0].content).toMatch(rewrittenRowRegex);
  });
});

describe('archivePlanImpl — 预检失败分支', () => {
  it('plan status 已是 completed → reject + 提示信息', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    // 改 plan frontmatter 为 status: completed
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        'status: completed',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('already "completed"');
    // git merge 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('Phase A4 / R1 MED-3：plan status = abandoned → reject + 指向 user CLAUDE 中止流程', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    state.files.set(
      planPath,
      [
        '---',
        `plan_id: ${input.planId}`,
        'status: abandoned',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('abandoned');
    expect((result as ArchivePlanError).hint).toContain('§Step 4');
    // git merge 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('Phase A4：plan status 缺失 / 非合法值 → reject 通用 status 错误', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planPath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    // 缺 status 字段
    state.files.set(
      planPath,
      ['---', `plan_id: ${input.planId}`, '---', '', 'body'].join('\n'),
    );
    const deps = makeDeps(state, [`${expectedMainRepo}/.git`, 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('status must be "in_progress"');
    expect((result as ArchivePlanError).error).toContain('<missing>');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('cwd 在 worktree 内 → reject + 提示先 ExitWorktree', async () => {
    const { state, input } = fixtureHappyPath();
    state.fakeCwd = `${input.worktreePath}/src/main/foo.ts`; // cwd 在 worktree 子树
    const deps = makeDeps(state, [
      `/Users/test/repo/.git`,
      'wb',
      '', // status clean，预检通过到 cwd 检查
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('inside the worktree');
    expect((result as ArchivePlanError).hint).toContain('ExitWorktree');
  });

  it('worktree dirty (status --porcelain 输出非空) → reject', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'wb',
      ' M src/main/foo.ts', // dirty
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('not clean');
  });

  it('detached HEAD (rev-parse --abbrev-ref 返回 "HEAD") → reject', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'HEAD', // detached
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('detached');
  });

  it('plan 文件不存在（默认三条路径都没找到）→ reject + 提示 hint 含三条 fallback 路径', async () => {
    const state = makeState();
    const input = {
      planId: 'no-such-plan',
      worktreePath: '/Users/test/repo/.claude/worktrees/no-such-plan',
      baseBranch: 'main',
    };
    state.files.set(input.worktreePath, '__dir__'); // REVIEW_33 H10：worktreePath 必须存在
    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'wb',
      '',
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('plan file not found');
    // archive-plan-tool-ux-followup-20260515 (a) fallback 链 3 档:
    // .claude/plans/ → plans/ → ~/.claude/plans/
    expect((result as ArchivePlanError).hint).toContain('/Users/test/repo/.claude/plans');
    expect((result as ArchivePlanError).hint).toContain('/Users/test/repo/plans');
    expect((result as ArchivePlanError).hint).toContain('/Users/test/.claude/plans');
  });
});

describe('archivePlanImpl — REVIEW_33 H10 worktreePath 存在性预检', () => {
  it('worktreePath 不存在（state.files 没标记）→ step 0 立即 reject + hint 提示重建 worktree', async () => {
    const state = makeState();
    const input = {
      planId: 'orphan-plan',
      worktreePath: '/Users/test/repo/.claude/worktrees/orphan-plan',
      baseBranch: 'main',
    };
    // 关键：state.files 不包含 worktreePath，模拟「worktree 已被手工 git worktree
    // remove / 跨设备同步未带 working tree」场景
    const deps = makeDeps(state, []); // git mock 不应被调用（step 0 就拦下）

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('worktree_path does not exist');
    expect((result as ArchivePlanError).error).toContain(input.worktreePath);
    expect((result as ArchivePlanError).hint).toContain('manually removed');
    expect((result as ArchivePlanError).hint).toContain('§Step 4 manual cleanup');
    // git 命令一次都不应被调用（最快短路）
    expect(state.gitCalls.length).toBe(0);
  });

  it('worktreePath 存在 → 走完正常预检流程（step 0 放行，step 1+ 继续）', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    // fixtureHappyPath 已设了 worktreePath 占位 → step 0 应放行
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
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
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    // step 0 放行后 step 1 git rev-parse 真的被调用
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
  });
});

// ─── CHANGELOG_99 archive caller (与 K2 baton 同款语义) ──────────────────

