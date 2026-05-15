/**
 * archive_plan impl ff-merge body preservation 单测
 * （plan archive-plan-content-overwritten-fix-20260515 Phase 1 Step 1.1）。
 *
 * **bug 场景**:caller 在 worktree branch 上 commit plan 文件回写
 *   (典型 Phase 5 收尾 commit:[x] step checklist / 跳过理由 / 当前进度 update 到 final
 *    state) → caller ExitWorktree → 调 archive_plan → archive_plan ff-merge worktree
 *    branch 进 main → main working tree 拿到回写后的 plan body。
 *
 * **bug 根因**:archive-plan-impl.ts step 6 在 ff-merge **之前** read planContent →
 *   step 7-8 ff-merge → step 9-10 用 step 6 读的旧 planContent.body + 改 frontmatter
 *   写新文件 → ff-merge 进来的 caller 回写被覆盖。
 *
 * **修法**:Step 1.2 把 step 10 改成「ff-merge 后重新 read planContent 拿 fresh body」,
 *   只改 frontmatter 字段不动 body。
 *
 * 本文件 case 1(本 Step 1.1):fail-first 守门 — 在现 archive-plan-impl.ts 上跑必 fail
 * (assert 归档 body 含 [x] checklist 但实际写的是旧 stub),Step 1.2 fix 后必 pass。
 *
 * Step 2.1 后续会在本文件 / 相邻文件加 case 2(regression baseline:caller 没在 worktree
 * branch commit 任何 plan 回写 → 行为不变,归档 body 与 stub 一致)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  archivePlanImpl,
  _isArchivePlanError,
} from '../tools/handlers/archive-plan-impl';
import type { ArchivePlanResult } from '../tools/handlers/archive-plan-impl';
import { fixtureHappyPath, makeDeps } from './archive-plan/_setup';

describe('archivePlanImpl — ff-merge body preservation (archive-plan-content-overwritten-fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caller 在 worktree branch commit plan 回写 → ff-merge 把 fresh body 带进 main → archive_plan 必须保留 fresh body(不能用 step 6 读的旧 stub 覆盖)', async () => {
    const { state, input, expectedMainRepo, expectedArchivedPath } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;

    // Sanity check: fixtureHappyPath 已写入 stub plan(step 6 read 拿到的就是这份)
    const stubContent = state.files.get(planFilePath);
    expect(stubContent).toBeTruthy();
    expect(stubContent).toContain('# Plan body content');
    expect(stubContent).not.toContain('[x] Step');

    // 模拟「caller 已在 worktree branch commit plan 回写」:body 含 [x] checklist + 当前进度
    // 等 final state。这是 ff-merge 之后 main working tree 应该看到的内容。
    const postFfMergeContent = [
      '---',
      `plan_id: ${input.planId}`,
      'created_at: 2026-05-13',
      `worktree_path: ${input.worktreePath}`,
      'status: in_progress',
      'base_commit: abc123',
      '---',
      '',
      '# Plan body content',
      '',
      '## 步骤 checklist',
      '- [x] Step 1.1 — done by lead on 2026-05-15, commit aaa111',
      '- [x] Step 1.2 — done by lead on 2026-05-15, commit bbb222',
      '- [x] Step 1.3 — done by lead on 2026-05-15, commit ccc333',
      '',
      '## 当前进度',
      '- ✅ Phase 1 完成,所有 step 已 commit',
    ].join('\n');

    // 标准 git stdouts 队列(与 happy path 同款 11 次调用)
    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`, // 1. rev-parse --git-common-dir
      'worktree-mcp-bug-fix', // 2. rev-parse --abbrev-ref HEAD
      '', // 3. status --porcelain (clean)
      'mainhash', // 4. rev-parse --verify main (REVIEW_33 H1)
      '', // 5. checkout main (REVIEW_33 H1)
      '', // 6. merge --ff-only worktree-mcp-bug-fix
      'finalhash123', // 7. rev-parse HEAD (post-ff-merge)
      '', // 8. add
      '', // 9. commit
      '', // 10. worktree remove
      '', // 11. branch -D
    ]);

    // **关键 hijack**:在 `git merge --ff-only` 调用时 mutate state.files →
    // 模拟 ff-merge 把 worktree branch 上 commit 的 plan 回写带进 main working tree。
    // 真实 git 行为同款:ff-merge 是 working tree update + ref move 的复合操作。
    let mergeMutated = false;
    const wrappedRunGit = baseDeps.runGit!;
    const deps = {
      ...baseDeps,
      runGit: async (args: string[], cwd: string) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          state.files.set(planFilePath, postFfMergeContent);
          mergeMutated = true;
        }
        return wrappedRunGit(args, cwd);
      },
    };

    const result = await archivePlanImpl(input, deps);

    expect(_isArchivePlanError(result)).toBe(false);
    expect(mergeMutated).toBe(true); // 守门 hijack 真生效

    const ok = result as ArchivePlanResult;
    expect(ok.archivedPath).toBe(expectedArchivedPath);
    expect(ok.commitHash).toBe('finalhash123');

    // **关键 assertion**:归档 plan body 必须含 fresh checklist [x]
    // (post-ff-merge body),不能用 step 6 读的 stub body 覆盖。
    const archivedWrite = state.writes.find((w) => w.path === expectedArchivedPath);
    expect(archivedWrite).toBeTruthy();
    // 行为变化:归档 body 含 caller 在 worktree branch commit 的 [x] checklist
    expect(archivedWrite!.content).toContain('[x] Step 1.1 — done by lead');
    expect(archivedWrite!.content).toContain('[x] Step 1.2 — done by lead');
    expect(archivedWrite!.content).toContain('[x] Step 1.3 — done by lead');
    expect(archivedWrite!.content).toContain('## 当前进度');
    expect(archivedWrite!.content).toContain('Phase 1 完成');
    // 行为不变:frontmatter 仍正确改 status / final_commit / completed_at
    expect(archivedWrite!.content).toContain('status: "completed"');
    expect(archivedWrite!.content).toContain('final_commit: "finalhash123"');
    expect(archivedWrite!.content).toContain('completed_at: "2026-05-15"');
    // body 不再含「stub 占位」的痕迹(原 # Plan body content 单独段后面没 checklist)
    // 注:post-ff-merge body 也包含 # Plan body content header,所以不能 not.toContain;
    // 关键判定是 [x] 与 ## 当前进度 真存在(若 fail = 用了旧 stub body)
  });

  it('regression: caller 没在 worktree branch commit plan 回写(stub 没动)→ archive_plan 行为不变,归档 body == stub body + frontmatter status=completed', async () => {
    const { state, input, expectedMainRepo, expectedArchivedPath } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;
    const stubContent = state.files.get(planFilePath);
    expect(stubContent).toBeTruthy();

    // ff-merge **不** mutate state.files(模拟 caller 没在 worktree branch 改 plan 文件 →
    // ff-merge 对 plan 文件是 no-op → fresh re-read 拿到的还是 stub)
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'finalhash456',
      '',
      '',
      '',
      '',
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);

    const archivedWrite = state.writes.find((w) => w.path === expectedArchivedPath);
    expect(archivedWrite).toBeTruthy();
    // 行为不变:body 仍含 stub 标记内容(无 [x] checklist)
    expect(archivedWrite!.content).toContain('# Plan body content');
    expect(archivedWrite!.content).toContain('Some details.');
    expect(archivedWrite!.content).not.toContain('[x] Step');
    expect(archivedWrite!.content).not.toContain('## 当前进度');
    // frontmatter 仍正确改 status / final_commit / completed_at
    expect(archivedWrite!.content).toContain('status: "completed"');
    expect(archivedWrite!.content).toContain('final_commit: "finalhash456"');
    expect(archivedWrite!.content).toContain('completed_at: "2026-05-15"');
    // 原 fm 字段(如 plan_id / worktree_path / base_commit)仍透传(freshFm 与 step 6 fm 一致)
    expect(archivedWrite!.content).toContain('plan_id: "mcp-bug-fix-20260513"');
    expect(archivedWrite!.content).toContain('base_commit: "abc123"');
  });

  it('post-ff-merge fresh re-read 失败(plan 文件被外部并发删除)→ postFfMergeErr [post-ff-merge:reread-plan-after-ffmerge] + 通用 hint', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;

    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'finalhash789',
      // git add / commit / worktree remove / branch -D 都不会被调用(短路在 step 8b)
    ]);
    // 关键:在 ff-merge 后(步骤 8 rev-parse HEAD 之前)删 plan 文件,模拟外部并发删除 /
    // 跨设备同步丢文件 / fs race。step 8b re-read 时 deps.readFile 抛 ENOENT。
    const wrappedRunGit = baseDeps.runGit!;
    const deps = {
      ...baseDeps,
      runGit: async (args: string[], cwd: string) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          state.files.delete(planFilePath); // ff-merge 后立即「外部删」plan
        }
        return wrappedRunGit(args, cwd);
      },
    };

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as { error: string; hint: string };
    expect(err.error).toContain('[post-ff-merge:reread-plan-after-ffmerge]');
    expect(err.error).toContain('ENOENT'); // makeDeps fake 抛这个 message
    expect(err.hint).toContain('ff-merge 已完成');
    expect(err.hint).toContain('phase 标识手工补完');
    // archive 写不应该发生(短路 in step 8b)
    expect(state.writes.find((w) => w.path.includes('plans/'))).toBeUndefined();
  });

  it('post-ff-merge fresh re-read frontmatter 缺失(caller 误删 frontmatter block)→ postFfMergeErr 提示 caller 修后再调', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;

    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'finalhashabc',
    ]);
    // ff-merge 把 frontmatter block 删了(caller 误操作模拟):body 还在但顶部 --- block 没了
    const wrappedRunGit = baseDeps.runGit!;
    const deps = {
      ...baseDeps,
      runGit: async (args: string[], cwd: string) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          state.files.set(planFilePath, '# Plan body without frontmatter\n\nSome details.\n');
        }
        return wrappedRunGit(args, cwd);
      },
    };

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as { error: string; hint: string };
    expect(err.error).toContain('[post-ff-merge:reread-plan-after-ffmerge]');
    expect(err.error).toContain('no parseable frontmatter');
    expect(err.error).toContain('worktree branch'); // 提示责任方
    expect(err.hint).toContain('ff-merge 已完成');
  });
});
