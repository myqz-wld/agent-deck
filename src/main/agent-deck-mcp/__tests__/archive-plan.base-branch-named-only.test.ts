/**
 * `assertBaseBranchIsNamedBranch` lambda 单测（plan deep-review-batch-a1-b-fixes-20260519
 * §Phase 1 Step 1.2 / B-HIGH-3 → plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 1.2c → §Phase R3 fix-2 H3 补 check-ref-format reject rev suffix）。
 *
 * **本测试目标**：lambda 必须 reject SHA / tag / 不存在 branch / **rev suffix（main~1 /
 * main^{commit} 等）**，仅放行 plain named branch（`refs/heads/<plain-name>`）。
 *
 * **R3 fix-2 (H3 codex Batch C+D HIGH-1)**：旧 impl 仅 `rev-parse --verify --quiet refs/heads/X`
 * 不够 — 实测 `git rev-parse --verify --quiet refs/heads/main~1` 返回 commit hash exit 0
 * （rev-parse 接受 `refs/heads/main~1` 作为 valid rev expression：从 main 倒退一个 commit）。
 * 后续 ff-merge `git checkout main~1` 进 detached HEAD → 归档 commit 落 detached HEAD → 数据
 * 丢失。R3 fix-2 加 `git check-ref-format --branch <name>` 一阶 reject rev syntax（exit 128）。
 *
 * **校验顺序（两阶）**：
 * 1. `git check-ref-format --branch <name>` reject rev syntax / invalid branch chars
 * 2. `git rev-parse --verify --quiet refs/heads/<name>` reject SHA / tag / 不存在 branch
 *
 * **case 覆盖**：
 * - happy: plain branch name（main / feature-x）→ 两阶都 OK → ok=true
 * - reject rev suffix（main~1 / main^{commit} / main@{1}）→ check-ref-format exit 128 → ok=false
 * - reject SHA / tag / 不存在 branch（v1.2.0 / abc123def / nonexistent）→ rev-parse 退码非 0 → ok=false
 */

import { describe, expect, it, vi } from 'vitest';
import { assertBaseBranchIsNamedBranch } from '../tools/handlers/archive-plan-impl';

describe('assertBaseBranchIsNamedBranch — H3 校验 (check-ref-format + rev-parse 两阶)', () => {
  // ============================================================================
  // happy: plain branch name → 两阶都 OK
  // ============================================================================
  it('合法 plain branch 名 main → ok=true（check-ref-format + rev-parse 都成功）', async () => {
    // 两次 mock：先 check-ref-format（empty stdout），再 rev-parse（sha 字符串）
    const runGit = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('abc123def4567890');
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'main' },
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(runGit).toHaveBeenCalledTimes(2);
    expect(runGit).toHaveBeenNthCalledWith(
      1,
      ['check-ref-format', '--branch', 'main'],
      '/Users/test/repo',
    );
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main'],
      '/Users/test/repo',
    );
  });

  it('feature branch 名 → ok=true', async () => {
    const runGit = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('feedface');
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'feature-x' },
    );
    expect(result.ok).toBe(true);
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  // ============================================================================
  // R3 fix-2 (H3): reject rev suffix via check-ref-format
  // ============================================================================
  it('R3 fix-2 H3: reject main~1 (rev suffix) → check-ref-format 失败 → ok=false + error 提示 rev syntax', async () => {
    // check-ref-format --branch main~1 → fatal: 'main~1' is not a valid branch name → exit 128
    const runGit = vi
      .fn()
      .mockRejectedValueOnce(new Error("fatal: 'main~1' is not a valid branch name"));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'main~1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/main~1/);
    expect(result.error).toMatch(/not a valid branch name/);
    expect(result.hint).toMatch(/rev expression/);
    expect(result.hint).toMatch(/detached HEAD/);
    // rev-parse 没被调用（first阶段就拦下）
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('R3 fix-2 H3: reject main^{commit} (peel suffix) → check-ref-format 失败', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValueOnce(new Error("fatal: 'main^{commit}' is not a valid branch name"));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'main^{commit}' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/main\^\{commit\}/);
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('R3 fix-2 H3: reject main@{1} (reflog suffix) → check-ref-format 失败', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValueOnce(new Error("fatal: 'main@{1}' is not a valid branch name"));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'main@{1}' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/main@\{1\}/);
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  // ============================================================================
  // rev-parse 路径 reject: SHA / tag / 不存在 branch（check-ref-format 通过但 rev-parse 失败）
  // ============================================================================
  it('reject tag 名 v1.2.0 → check-ref-format OK + rev-parse 失败 → ok=false', async () => {
    // check-ref-format --branch v1.2.0 通过（valid branch name 字符）
    // 但 rev-parse --verify --quiet refs/heads/v1.2.0 失败（不在 heads namespace）
    const runGit = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('fatal: Needed a single revision'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'v1.2.0' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/v1\.2\.0/);
    expect(result.error).toMatch(/not a named branch/);
    expect(result.error).toMatch(/refs\/heads/);
    expect(result.hint).toMatch(/named branch/);
    expect(result.hint).toMatch(/branch --list/);
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('reject SHA abc1234567890 → ok=false + error 含 SHA / tag 不允许提示', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('fatal: Not a git ref'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'abc1234567890' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abc1234567890/);
    expect(result.error).toMatch(/SHA \/ tag \/ detached HEAD/);
  });

  it('reject 不存在 branch nonexistent-branch → ok=false + error 提示具体名', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('fatal: ambiguous argument'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'nonexistent-branch' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nonexistent-branch/);
    expect(result.hint).toMatch(/Edit plan frontmatter base_branch/);
  });

  it('rejected (rev-parse 失败) 时 hint 同时含 git stderr 摘录 + Verify 命令', async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('fatal: bad revision name'));
    const result = await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/test/repo', baseBranch: 'broken-ref' },
    );
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/bad revision name/);
    expect(result.hint).toMatch(/git -C \/Users\/test\/repo branch --list/);
  });

  it('args 透传：check-ref-format + rev-parse 两次调用 / cwd / refs/heads 前缀完整', async () => {
    const runGit = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('sha');
    await assertBaseBranchIsNamedBranch(
      { runGit },
      { mainRepoAbsPath: '/Users/foo/bar', baseBranch: 'develop' },
    );
    expect(runGit).toHaveBeenCalledTimes(2);
    expect(runGit).toHaveBeenNthCalledWith(
      1,
      ['check-ref-format', '--branch', 'develop'],
      '/Users/foo/bar',
    );
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      ['rev-parse', '--verify', '--quiet', 'refs/heads/develop'],
      '/Users/foo/bar',
    );
  });
});
