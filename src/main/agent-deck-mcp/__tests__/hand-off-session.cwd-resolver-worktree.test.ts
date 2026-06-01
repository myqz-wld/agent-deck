/**
 * hand-off-session cwd-resolver `validatePlanModeWorktreeExists` 决策树单测
 * （plan sqlite-tests-no-skip-20260601 D8b / deep-review R1 codex MED-2 补测盲区）。
 *
 * 背景：D8 只测了 impl 层 `worktreeExists` flag（impl 不再 hard-reject，返结构化 flag）。
 * 真实「worktree 不存在」的 4-case 决策在 handler 层 `validatePlanModeWorktreeExists`
 * （cwd-resolver.ts:184，REVIEW_56 Batch B R2 MED-1 + CHANGELOG_169 F3），原先无任何专属 test。
 *
 * 纯函数单测：直接喂 ResolvedForCwd + finalCwd，断言 reject（{result}）/ 放行（null）。
 * 不真碰 fs / git / SDK。
 */
import { describe, expect, it } from 'vitest';
import {
  validatePlanModeWorktreeExists,
  type ResolvedForCwd,
} from '../tools/handlers/hand-off-session/cwd-resolver';

const MAIN_REPO = '/Users/test/repo';
const CONVENTIONAL_WT = '/Users/test/repo/.claude/worktrees/plan-x'; // mainRepo subtree
const EXTERNAL_WT = '/Users/test/external/worktrees/plan-x'; // 非 mainRepo subtree

function resolved(over: Partial<ResolvedForCwd> = {}): ResolvedForCwd {
  return {
    mode: 'plan',
    mainRepo: MAIN_REPO,
    worktreePath: CONVENTIONAL_WT,
    worktreeExists: false, // 决策树只在 worktree 不存在时触发
    ...over,
  };
}

/** 解析 err() 返回的 HandlerResult.content[0].text JSON payload。 */
function parseRejectPayload(r: { result: { content: Array<{ text: string }> } }): {
  error: string;
  hint?: string;
} {
  return JSON.parse(r.result.content[0].text);
}

describe('validatePlanModeWorktreeExists — worktree missing 4-case 决策树（codex MED-2 补测）', () => {
  it('case 0: worktreeExists=true → null（不触发决策，正常放行）', () => {
    expect(validatePlanModeWorktreeExists(resolved({ worktreeExists: true }), MAIN_REPO)).toBeNull();
  });

  it('case 0b: mode=generic → null（仅 plan 模式校验 worktree）', () => {
    expect(validatePlanModeWorktreeExists(resolved({ mode: 'generic' }), MAIN_REPO)).toBeNull();
  });

  it('case 1: 约定 worktree(mainRepo subtree) + finalCwd=mainRepo → null（放行，让 cold-start 自建）', () => {
    // finalCwd 落 mainRepo，新 session 按 cold-start 协议自己 enter_worktree 重建。
    const r = validatePlanModeWorktreeExists(resolved(), MAIN_REPO);
    expect(r).toBeNull();
  });

  it('case 2: finalCwd === worktreePath → hard reject（cwd 即将进失效目录，spawn 必 ENOENT）', () => {
    const r = validatePlanModeWorktreeExists(resolved(), CONVENTIONAL_WT);
    expect(r).not.toBeNull();
    const payload = parseRejectPayload(r!);
    expect(payload.error).toContain('worktree_path does not exist on disk');
    expect(payload.error).toContain(CONVENTIONAL_WT);
    // hint 指引重建 worktree
    expect(payload.hint).toContain('git worktree add');
  });

  it('case 3: 外置 worktree(非 mainRepo subtree) → hard reject（父目录也不存在，无法 cold-start 自建）', () => {
    const r = validatePlanModeWorktreeExists(
      resolved({ worktreePath: EXTERNAL_WT }),
      MAIN_REPO, // finalCwd=mainRepo 但 worktree 是外置
    );
    expect(r).not.toBeNull();
    const payload = parseRejectPayload(r!);
    expect(payload.error).toContain('worktree_path does not exist on disk');
    expect(payload.hint).toContain('git worktree add');
  });

  it('case 4: 约定 worktree 但 finalCwd 在 mainRepo 外(如 /tmp) → hard reject（CHANGELOG_169 F3 finalCwdInMainRepo）', () => {
    // isInternalWorktree=true 但 finalCwd 不在 mainRepo subtree → cold-start 无法从 caller cwd
    // 反查 mainRepo → reject（修前此路径被静默放行落错 cwd）。
    const r = validatePlanModeWorktreeExists(resolved(), '/tmp/somewhere');
    expect(r).not.toBeNull();
    const payload = parseRejectPayload(r!);
    expect(payload.error).toContain('worktree_path does not exist on disk');
  });
});
