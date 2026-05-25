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
import * as path from 'node:path';
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

    // 标准 git stdouts 队列(REVIEW_56 Batch B R1 MED-1 后 12 次调用,commit 之后插入
    // archive-rev-parse-HEAD 拿 archiveCommit)
    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`, // 1. rev-parse --git-common-dir
      'worktree-mcp-bug-fix', // 2. rev-parse --abbrev-ref HEAD
      '', // 3. status --porcelain (clean)
      'mainhash', // 4. rev-parse --verify main (REVIEW_33 H1)
      '', // 5. checkout main (REVIEW_33 H1)
      '', // 6. merge --ff-only worktree-mcp-bug-fix
      'finalhash123', // 7. rev-parse HEAD (post-ff-merge, finalCommit)
      '', // 8. add
      '', // 9. commit
      'archivehash', // 10. rev-parse HEAD (archiveCommit, REVIEW_56 Batch B R1 MED-1)
      '', // 11. worktree remove
      '', // 12. branch -D
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
    expect(ok.commitHash).toBe('archivehash');

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
      'archivehash',
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

  // ─── Phase 3.1 R1 异构对抗 review fix 守门 case ──────────────────────────
  // R1 双方独立提出 1 HIGH(INDEX summary 用 stale fm.description)+ 反驳轮 codex 单方
  // HIGH(step 8b 后未 re-validate status)。fix:line 387 freshFm.description / 8c 加 status
  // re-check。下面两 case 守门 R1 fix,fix 前必 fail / fix 后必 pass。

  it('R1 fix HIGH-A 守门: caller 在 worktree branch commit 改 description 字段 → INDEX.md summary 必须用 freshFm.description(不能用 step 6 stale fm)', async () => {
    const { state, input, expectedMainRepo, expectedArchivedPath } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;

    // post-ff-merge:caller 在 worktree branch 收尾 commit 加 description 字段(stub 没该字段)
    const freshDescription = '完整收尾概要-post-ff-merge-fresh-description';
    const postFfMergeContent = [
      '---',
      `plan_id: ${input.planId}`,
      'created_at: 2026-05-13',
      `worktree_path: ${input.worktreePath}`,
      'status: in_progress',
      'base_commit: abc123',
      `description: ${freshDescription}`,
      '---',
      '',
      '# Plan body content',
      '',
      'Some details with collapsed scope.',
    ].join('\n');

    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'finalhashdesc',
      '',
      '',
      'archivehash',
      '',
      '',
    ]);
    const wrappedRunGit = baseDeps.runGit!;
    const deps = {
      ...baseDeps,
      runGit: async (args: string[], cwd: string) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          state.files.set(planFilePath, postFfMergeContent);
        }
        return wrappedRunGit(args, cwd);
      },
    };

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);

    // 1. archived plan body 含 fresh description fm 字段(R1 主 case 同款验证 freshFm 透传)
    const archivedWrite = state.writes.find((w) => w.path === expectedArchivedPath);
    expect(archivedWrite).toBeTruthy();
    expect(archivedWrite!.content).toContain(`description: "${freshDescription}"`);

    // 2. **关键 assertion**:plans/INDEX.md 必须用 freshFm.description(不能 fallback 到
    // freshFm.plan_id 或 input.planId,这是 fix 前的 buggy 行为 — fm.description undefined
    // 时 fallback 链落到 fm.plan_id == input.planId)
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    const indexWrites = state.writes.filter((w) => w.path === indexPath);
    expect(indexWrites.length).toBeGreaterThan(0);
    const lastIndexWrite = indexWrites[indexWrites.length - 1];
    expect(lastIndexWrite.content).toContain(freshDescription);
    // 反向守门:INDEX.md 不应该用 plan_id fallback(若 fix 前 buggy,summary 会落到 plan_id)
    // 验证手段:archive-plan-tool-ux-followup-20260515 (c) 4 列 row format:
    // `| [<id>.md](<id>.md) | completed | <changelog or "—"> | <description> |`
    // description 在第 4 列;regex 用 4 个 ` \| ` 分隔的 cells 锚定。
    const summaryColumnRegex = new RegExp(
      `\\| \\[${input.planId}\\.md\\]\\(${input.planId}\\.md\\) \\| completed \\| [^|]+ \\| ([^|]+) \\|`,
    );
    const match = lastIndexWrite.content.match(summaryColumnRegex);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe(freshDescription);
  });

  it('R1 fix HIGH-B 守门: caller 在 worktree branch commit 把 status 改 abandoned → archive_plan 必须 postFfMergeErr 拒绝(不能静默归档为 completed)', async () => {
    const { state, input, expectedMainRepo, expectedArchivedPath } = fixtureHappyPath();
    const planFilePath = `${expectedMainRepo}/.claude/plans/${input.planId}.md`;

    // post-ff-merge:caller 在 worktree branch 中途变卦 commit `status: abandoned` 后忘改回
    // (Scenario A;reviewer-claude 反驳轮列举 3 现实场景之一)
    const postFfMergeContent = [
      '---',
      `plan_id: ${input.planId}`,
      'created_at: 2026-05-13',
      `worktree_path: ${input.worktreePath}`,
      'status: abandoned', // ← 关键:fresh status 漂移到 abandoned
      'base_commit: abc123',
      '---',
      '',
      '# Plan body content',
      '',
      '## 中止理由',
      '- caller 中途决定不 ship,但又改主意继续推进 fix,忘了把 status 撤回 in_progress',
    ].join('\n');

    const baseDeps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'mainhash',
      '',
      '',
      'finalhashabandoned',
      // git add / commit / worktree remove / branch -D 都不会被调用(短路在 step 8c)
    ]);
    const wrappedRunGit = baseDeps.runGit!;
    const deps = {
      ...baseDeps,
      runGit: async (args: string[], cwd: string) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          state.files.set(planFilePath, postFfMergeContent);
        }
        return wrappedRunGit(args, cwd);
      },
    };

    const result = await archivePlanImpl(input, deps);

    // 1. **关键 assertion**:必须返回 ArchivePlanError 拒绝(不能 ok)
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as { error: string; hint: string };
    expect(err.error).toContain('[post-ff-merge:reread-plan-after-ffmerge]');
    expect(err.error).toContain('status changed to "abandoned"');
    expect(err.error).toContain('in_progress'); // 提示原 preflight 校验值
    expect(err.error).toContain('§Step 4'); // 引 user CLAUDE.md 中止契约

    // 2. hint 含 cleanup 指引(R2 MED 1 fix:范围化命令而非 `git revert HEAD` 单 commit;
    //    R3 MED 1 fix:选项 (2) 闭合 — 仅在 worktree branch 修,防 caller 误编辑 main;
    //    R4 LOW 1 fix:revert 限定 abandoned 路径(选项 1),continue 必须 reset 防 git 拓扑分叉)
    expect(err.hint).toContain('git reset --hard ORIG_HEAD'); // 推荐路径(干净简单)
    expect(err.hint).toContain('git revert ORIG_HEAD..HEAD'); // history-preserving 选项(限选项 1)
    expect(err.hint).toContain('§Step 4'); // 引中止流程
    expect(err.hint).toContain('git worktree remove'); // 中止流程动作
    expect(err.hint).toContain('status: in_progress'); // 另一选择:撤回继续推进
    expect(err.hint).toContain('only on the worktree branch'); // R3 MED 1 闭合:防 caller 误编辑 main repo plan
    expect(err.hint).toContain('do NOT edit main repo'); // R3 MED 1 反向锚点
    expect(err.hint).toContain('do NOT use revert for option 2'); // R4 LOW 1:防 revert+continue 拓扑分叉
    expect(err.hint).toContain('only valid for option 1'); // R4 LOW 1 反向锚点(revert 限 abandoned)

    // 3. archive 写不应该发生(短路 in step 8c,不到 step 10 写 archived plan / step 11 INDEX)
    const archivedWrite = state.writes.find((w) => w.path === expectedArchivedPath);
    expect(archivedWrite).toBeUndefined();
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    const indexWrite = state.writes.find((w) => w.path === indexPath);
    expect(indexWrite).toBeUndefined();
    // 4. 原 plan 文件没被 unlink(短路在 step 8c,step 12 unlink 不会跑)
    expect(state.unlinks).toEqual([]);
  });
});
