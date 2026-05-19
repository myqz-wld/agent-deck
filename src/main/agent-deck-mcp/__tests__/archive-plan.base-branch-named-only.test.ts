/**
 * `assertBaseBranchIsNamedBranch` lambda 单测（plan deep-review-batch-a1-b-fixes-20260519
 * §Phase 1 Step 1.2 / B-HIGH-3 → plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 1.2c）。
 *
 * **本测试目标**：lambda 必须 reject SHA / tag / 不存在 branch，仅放行 named branch
 * （`refs/heads/<name>`）。旧 impl `rev-parse --verify <branch>` 默认 namespace 含 raw
 * SHA / tag / remote refs，让 caller 误传 tag 名（如 plan frontmatter `base_branch:
 * v1.2.0`）后 checkout tag 落 detached HEAD → ff-merge 推 HEAD → branch -D worktreeBranch
 * 删工作分支 → 归档 commit 仅 reflog 可达，gc 30 天后丢失（B-HIGH-3 reviewer-claude
 * 反驳轮 git 端到端实测复现）。
 *
 * **3 reject case**（plan §Phase 1.2c）：
 * 1. tag 名（如 `v1.2.0`）→ git rev-parse --verify --quiet refs/heads/v1.2.0 → 退码非 0
 * 2. SHA（如 `abc123def...`）→ refs/heads/abc... 不存在 → 退码非 0
 * 3. 不存在 branch（如 `nonexistent-branch`）→ refs/heads/nonexistent-branch 不存在 → 退码非 0
 *
 * **1 pass case**：合法 branch 名（如 `main` / `feature-x`） → git rev-parse 成功（返 sha）。
 */

import { describe, expect, it, vi } from 'vitest';
import { assertBaseBranchIsNamedBranch } from '../tools/handlers/archive-plan-impl';

describe('assertBaseBranchIsNamedBranch — B-HIGH-3 refs/heads namespace 校验', () => {
  it('合法 branch 名 → ok=true（git rev-parse 成功返 sha）', async () => {
    // git rev-parse --verify --quiet refs/heads/main → sha 字符串
    const runGit = vi.fn().mockResolvedValue('abc123def4567890');
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'main' },
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(runGit).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main'],
      '/Users/test/repo',
    );
  });

  it('feature branch 名 → ok=true', async () => {
    const runGit = vi.fn().mockResolvedValue('feedface1234567890');
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'feature-x' },
    );
    expect(result.ok).toBe(true);
  });

  it('reject case 1: tag 名（如 v1.2.0） → ok=false + error 含 named branch 提示', async () => {
    // tag 名走 refs/heads/v1.2.0 不存在 → git 失败
    const runGit = vi
      .fn()
      .mockRejectedValue(new Error('fatal: Needed a single revision'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'v1.2.0' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/v1\.2\.0/);
    expect(result.error).toMatch(/not a named branch/);
    expect(result.error).toMatch(/refs\/heads/);
    expect(result.hint).toMatch(/named branch/);
    expect(result.hint).toMatch(/branch --list/);
  });

  it('reject case 2: SHA（如 abc1234567890） → ok=false + error 含 SHA / tag 不允许提示', async () => {
    // SHA 也不在 refs/heads/ namespace
    const runGit = vi.fn().mockRejectedValue(new Error('fatal: Not a git ref'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'abc1234567890' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abc1234567890/);
    expect(result.error).toMatch(/SHA \/ tag \/ detached HEAD/);
  });

  it('reject case 3: 不存在 branch（如 nonexistent-branch） → ok=false + error 提示具体名', async () => {
    const runGit = vi.fn().mockRejectedValue(new Error('fatal: ambiguous argument'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'nonexistent-branch' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nonexistent-branch/);
    // hint 给修复建议
    expect(result.hint).toMatch(/Edit plan frontmatter base_branch/);
  });

  it('rejected 时 hint 同时含 git stderr 摘录 + Verify 命令', async () => {
    const runGit = vi.fn().mockRejectedValue(new Error('fatal: bad revision name'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'broken/ref' },
    );
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/bad revision name/); // stderr 摘录
    expect(result.hint).toMatch(/git -C \/Users\/test\/repo branch --list/); // Verify cmd
  });

  it('args 透传：runGit 调用次数 / cwd / refs/heads 前缀完整', async () => {
    const runGit = vi.fn().mockResolvedValue('sha');
    await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/foo/bar', baseBranch: 'develop' },
    );
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/heads/develop'],
      '/Users/foo/bar',
    );
  });
});
