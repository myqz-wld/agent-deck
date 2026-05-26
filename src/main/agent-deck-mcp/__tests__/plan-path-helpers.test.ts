/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.9 测试 (B-MED-3 双方独立强冗余):
 * resolvePlanFilePath helper 3 档 fallback (projectLocal > projectArchived > userGlobal)。
 *
 * **测试覆盖**:
 * - mainRepo 非空 + projectLocal 命中 → 返 projectLocal
 * - mainRepo 非空 + projectLocal 缺失 + projectArchived 命中 → 返 projectArchived (本项目实际惯例)
 * - mainRepo 非空 + 前两档缺失 + userGlobal 命中 → 返 userGlobal
 * - mainRepo 非空 + 三档全缺 → reject + hint 含 3 条 path
 * - mainRepo === null (caller cwd 不在 git repo) → 跳过 project-scoped,仅查 userGlobal
 * - mainRepo === null + userGlobal 缺失 → reject + hint 注明跳过 mainRepo lookups
 */
import { describe, expect, it } from 'vitest';
import { resolvePlanFilePath } from '../tools/handlers/plan-path-helpers';

function makeMockDeps(existingPaths: Set<string>, homedir: string) {
  return {
    exists: async (p: string) => existingPaths.has(p),
    homedir: () => homedir,
  };
}

describe('Phase 3 Step 3.9 — resolvePlanFilePath helper (B-MED-3 双方独立强冗余)', () => {
  const PLAN_ID = 'my-plan-20260519';
  const MAIN_REPO = '/Users/test/repo';
  const HOME = '/Users/test';

  it('档 1: projectLocal 命中 → 返 projectLocal', async () => {
    const projectLocal = `${MAIN_REPO}/.claude/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([projectLocal]), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect('path' in r).toBe(true);
    expect((r as { path: string }).path).toBe(projectLocal);
  });

  it('档 2: projectLocal 缺失 + projectArchived 命中 → 返 projectArchived(本项目实际惯例)', async () => {
    const projectArchived = `${MAIN_REPO}/ref/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([projectArchived]), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect('path' in r).toBe(true);
    expect((r as { path: string }).path).toBe(projectArchived);
  });

  it('档 3: 前两档缺失 + userGlobal 命中 → 返 userGlobal', async () => {
    const userGlobal = `${HOME}/.claude/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([userGlobal]), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect('path' in r).toBe(true);
    expect((r as { path: string }).path).toBe(userGlobal);
  });

  it('mainRepo 非空 + 三档全缺 → reject + hint 含 3 条 path', async () => {
    const deps = makeMockDeps(new Set(), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('plan file not found');
    expect(r.hint).toContain(`${MAIN_REPO}/.claude/plans`);
    expect(r.hint).toContain(`${MAIN_REPO}/ref/plans`);
    expect(r.hint).toContain(`${HOME}/.claude/plans`);
    expect(r.hint).toContain(PLAN_ID);
  });

  it('mainRepo === null + userGlobal 命中 → 返 userGlobal,跳过 project-scoped', async () => {
    const userGlobal = `${HOME}/.claude/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([userGlobal]), HOME);
    const r = await resolvePlanFilePath(null, PLAN_ID, deps);
    expect('path' in r).toBe(true);
    expect((r as { path: string }).path).toBe(userGlobal);
  });

  it('mainRepo === null + userGlobal 缺失 → reject + hint 注明跳过 mainRepo lookups', async () => {
    const deps = makeMockDeps(new Set(), HOME);
    const r = await resolvePlanFilePath(null, PLAN_ID, deps);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('plan file not found');
    expect(r.hint).toContain('not a git repo');
    expect(r.hint).toContain(`${HOME}/.claude/plans`);
    expect(r.hint).not.toContain(`${MAIN_REPO}/.claude/plans`);
    expect(r.hint).not.toContain(`${MAIN_REPO}/ref/plans`);
  });

  it('优先级: 三档同时存在 → 返档 1 (projectLocal)', async () => {
    const projectLocal = `${MAIN_REPO}/.claude/plans/${PLAN_ID}.md`;
    const projectArchived = `${MAIN_REPO}/ref/plans/${PLAN_ID}.md`;
    const userGlobal = `${HOME}/.claude/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([projectLocal, projectArchived, userGlobal]), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect((r as { path: string }).path).toBe(projectLocal);
  });

  it('优先级: 仅档 2 + 档 3 存在 → 返档 2 (projectArchived 比 userGlobal 优先)', async () => {
    const projectArchived = `${MAIN_REPO}/ref/plans/${PLAN_ID}.md`;
    const userGlobal = `${HOME}/.claude/plans/${PLAN_ID}.md`;
    const deps = makeMockDeps(new Set([projectArchived, userGlobal]), HOME);
    const r = await resolvePlanFilePath(MAIN_REPO, PLAN_ID, deps);
    expect((r as { path: string }).path).toBe(projectArchived);
  });
});
