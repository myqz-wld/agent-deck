/**
 * `assertMainRepoCleanForArchive` lambda 单测（plan deep-review-batch-a1-b-followup-r3
 * -20260519 §Phase 1.2d / D3 / 不变量 5）。
 *
 * **本测试目标**：lambda 精确化 mainRepo dirty precheck 5 status 类型 × 命中/不命中三具体
 * 路径矩阵覆盖。Phase 4.2/4.3 精确化后行为：
 * - **命中三具体路径**（archivedPath / indexPath / planFilePath，转 repo-relative 比对）：
 *   reject → conflicts 数组 + ok=false
 * - **不命中**：warning → warnings 数组 + ok=true（commit 阶段会用 pathspec 隔离不吞）
 *
 * **5+ status 类型**（plan §Phase 1.2d 要求覆盖）：
 * - `M ` staged-only：X='M' Y=' '
 * - ` M` unstaged-only：X=' ' Y='M'
 * - `MM` 双侧 modified：X='M' Y='M'
 * - `??` untracked
 * - `R ` rename（status[0]='R'，两段 NUL 分隔 newname/oldname）
 * - `C ` copy（status[0]='C'，两段 NUL 分隔）
 *
 * **rename/copy 双 path 任一命中即 reject**（R3 codex MED-3 修订）：
 * - 命中 newname → conflict
 * - 命中 oldname → conflict（重命名 plan/INDEX/archived 路径风险高）
 * - 都不命中 → warning
 *
 * **critical paths repo-relative 比对铁证**（R3 codex MED-1 修订）：
 * - mainRepoAbsPath = `/Users/test/repo`
 * - archivedPath（绝对）= `/Users/test/repo/ref/plans/<id>.md`
 * - 转 repo-relative = `ref/plans/<id>.md` ← 与 git status --porcelain 输出对齐
 *
 * **NUL 分隔 parser 铁证**（R2 MED-C 修订）：
 * - git status --porcelain=v1 -z 输出 `M  ref/plans/<id>.md\0` 含 NUL trailer
 * - 含空格 / 中文 / quoted path 都用 NUL 分隔（newline parser 漏 rename/copy 类型）
 */

import { describe, expect, it, vi } from 'vitest';
import { assertMainRepoCleanForArchive } from '../tools/handlers/archive-plan-impl';

// ============================================================================
// fixture：mainRepo 路径常量 + 三具体 critical 绝对路径
// ============================================================================
const MAIN_REPO = '/Users/test/repo';
const ARCHIVED_PATH = '/Users/test/repo/ref/plans/plan-xyz-20260519.md'; // = mainRepo/ref/plans/<id>.md
const INDEX_PATH = '/Users/test/repo/ref/plans/INDEX.md';
const PLAN_FILE_PATH = '/Users/test/repo/.claude/plans/plan-xyz-20260519.md';

// 三具体 critical 转 repo-relative（与 lambda 内部 path.relative 推导一致）：
//   archivedPath rel = 'ref/plans/plan-xyz-20260519.md'
//   indexPath rel = 'ref/plans/INDEX.md'
//   planFilePath rel = '.claude/plans/plan-xyz-20260519.md'

// ============================================================================
// helper：构造 NUL-separated porcelain v1 -z output
// ============================================================================
/** 普通 entry: "XY filename\0" */
function nulEntry(status: string, filename: string): string {
  return `${status} ${filename}\0`;
}
/** rename/copy entry: "RY newname\0oldname\0" */
function nulRenameEntry(status: string, newname: string, oldname: string): string {
  return `${status} ${newname}\0${oldname}\0`;
}

const fixedInput = {
  mainRepoAbsPath: MAIN_REPO,
  archivedPath: ARCHIVED_PATH,
  indexPath: INDEX_PATH,
  planFilePath: PLAN_FILE_PATH,
};

describe('assertMainRepoCleanForArchive — clean baseline', () => {
  it('git status 输出空 → ok=true / conflicts=[] / warnings=[]', async () => {
    const runGit = vi.fn().mockResolvedValue('');
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(runGit).toHaveBeenCalledWith(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      MAIN_REPO,
      { raw: true },
    );
  });
});

describe('assertMainRepoCleanForArchive — 5 status × 命中 critical → conflicts (reject)', () => {
  // (1) staged-only M
  it('staged M 命中 archivedPath → conflict + ok=false', async () => {
    const stdout = nulEntry('M ', 'ref/plans/plan-xyz-20260519.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: 'ref/plans/plan-xyz-20260519.md',
      status: 'M ',
    });
    expect(result.warnings).toEqual([]);
  });

  // (2) unstaged-only M
  it('unstaged M 命中 indexPath → conflict + ok=false', async () => {
    const stdout = nulEntry(' M', 'ref/plans/INDEX.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: 'ref/plans/INDEX.md',
      status: ' M',
    });
  });

  // (3) 双侧 modified
  it('MM 双侧 modified 命中 planFilePath → conflict + ok=false', async () => {
    const stdout = nulEntry('MM', '.claude/plans/plan-xyz-20260519.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: '.claude/plans/plan-xyz-20260519.md',
      status: 'MM',
    });
  });

  // (4) untracked
  it('?? untracked 命中 archivedPath（caller 在 ref/plans/ 提前手写归档目标）→ conflict + ok=false', async () => {
    const stdout = nulEntry('??', 'ref/plans/plan-xyz-20260519.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: 'ref/plans/plan-xyz-20260519.md',
      status: '??',
    });
  });

  // (5) Rename — new path 命中
  it('R rename 新路径命中 archivedPath → conflict + ok=false (R3 codex MED-3)', async () => {
    // RY 格式：newname\0oldname\0 — caller 把 ref/plans/old-id.md 重命名到 ref/plans/<本 id>.md
    const stdout = nulRenameEntry(
      'R ',
      'ref/plans/plan-xyz-20260519.md', // newname (命中 critical)
      'ref/plans/old-plan.md', // oldname (不命中)
    );
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    // displayPath = "oldname -> newname"（REVIEW_74 INFO: 与人类 git status 方向一致）
    expect(result.conflicts[0]).toEqual({
      path: 'ref/plans/old-plan.md -> ref/plans/plan-xyz-20260519.md',
      status: 'R ',
    });
  });

  // (6) Rename — old path 命中（攻击向量：caller 把 ref/plans/<本 id>.md 改名到别处）
  it('R rename 旧路径命中 indexPath → conflict + ok=false (R3 codex MED-3 双 path 检查)', async () => {
    // caller 把 plans/INDEX.md 重命名到别的位置 → oldname='ref/plans/INDEX.md' 命中
    const stdout = nulRenameEntry(
      'R ',
      'ref/plans/old-INDEX.md', // newname (不命中)
      'ref/plans/INDEX.md', // oldname (命中 critical — INDEX 改名风险高)
    );
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: 'ref/plans/INDEX.md -> ref/plans/old-INDEX.md',
      status: 'R ',
    });
  });

  // (7) Copy — new path 命中
  it('C copy 新路径命中 planFilePath → conflict + ok=false', async () => {
    const stdout = nulRenameEntry(
      'C ',
      '.claude/plans/plan-xyz-20260519.md', // newname 命中 critical
      'docs/template.md',
    );
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      path: 'docs/template.md -> .claude/plans/plan-xyz-20260519.md',
      status: 'C ',
    });
  });
});

describe('assertMainRepoCleanForArchive — 5 status × 不命中 critical → warnings (warn pass)', () => {
  it('staged M 不命中 critical → warning + ok=true', async () => {
    const stdout = nulEntry('M ', 'src/main/index.ts');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({ path: 'src/main/index.ts', status: 'M ' });
    expect(result.conflicts).toEqual([]);
  });

  it('unstaged M 不命中 critical → warning + ok=true', async () => {
    const stdout = nulEntry(' M', 'README.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([{ path: 'README.md', status: ' M' }]);
  });

  it('?? untracked 不命中 critical → warning + ok=true', async () => {
    const stdout = nulEntry('??', 'src/temp-debug.log');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([{ path: 'src/temp-debug.log', status: '??' }]);
  });

  it('MM 不命中 critical → warning + ok=true', async () => {
    const stdout = nulEntry('MM', 'src/preload/api.ts');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([{ path: 'src/preload/api.ts', status: 'MM' }]);
  });

  it('R rename 双 path 都不命中 critical → warning + ok=true', async () => {
    const stdout = nulRenameEntry('R ', 'src/new-name.ts', 'src/old-name.ts');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      { path: 'src/old-name.ts -> src/new-name.ts', status: 'R ' },
    ]);
  });

  it('C copy 双 path 都不命中 critical → warning + ok=true', async () => {
    const stdout = nulRenameEntry('C ', 'src/copy.ts', 'src/origin.ts');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      { path: 'src/origin.ts -> src/copy.ts', status: 'C ' },
    ]);
  });
});

describe('assertMainRepoCleanForArchive — 多 entry 混合：critical + non-critical', () => {
  it('多 entry 含命中 + 不命中 → conflicts 仅 critical / warnings 收 non-critical', async () => {
    // 4 entries: 2 critical + 2 non-critical
    const stdout =
      nulEntry('M ', 'ref/plans/plan-xyz-20260519.md') + // critical (archivedPath)
      nulEntry(' M', 'src/main/index.ts') + // non-critical
      nulEntry('??', 'ref/plans/INDEX.md') + // critical (indexPath untracked)
      nulRenameEntry('R ', 'src/copy.ts', 'src/origin.ts'); // non-critical rename
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.map((c) => c.path).sort()).toEqual([
      'ref/plans/INDEX.md',
      'ref/plans/plan-xyz-20260519.md',
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.map((w) => w.path).sort()).toEqual([
      'src/main/index.ts',
      'src/origin.ts -> src/copy.ts',
    ]);
  });
});

describe('assertMainRepoCleanForArchive — git status 失败兜底', () => {
  it('git status 抛 error → ok=false + conflicts 含 <git-status-failed> entry', async () => {
    const runGit = vi.fn().mockRejectedValue(new Error('fatal: not a git repository'));
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].path).toBe('<git-status-failed>');
    expect(result.conflicts[0].status).toMatch(/not a git repository/);
    expect(result.warnings).toEqual([]);
  });
});

describe('assertMainRepoCleanForArchive — repo-relative 转换 (R3 codex MED-1)', () => {
  it('critical 路径用 path.relative(mainRepo, ...) 转换 — 绝对 vs relative 比对正确命中', async () => {
    // 关键铁证：input archivedPath 是绝对路径 '/Users/test/repo/ref/plans/<id>.md'，但
    // git status 输出 repo-relative 'ref/plans/<id>.md'。lambda 内部 path.relative 转换确保
    // criticalSet 含 repo-relative 与 git 输出对齐 → 命中 conflict。
    const stdout = nulEntry('M ', 'ref/plans/plan-xyz-20260519.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
  });

  it('mainRepo 嵌套深 path 也正确转换（防 startsWith 半匹配 bug）', async () => {
    const deepInput = {
      mainRepoAbsPath: '/Users/test/repo',
      archivedPath: '/Users/test/repo/ref/plans/deep-id.md',
      indexPath: '/Users/test/repo/ref/plans/INDEX.md',
      planFilePath: '/Users/test/repo/.claude/plans/deep-id.md',
    };
    // git 输出含 'plans/' 前缀但 path 不同 — 不应误命中 critical 'ref/plans/deep-id.md'
    const stdout = nulEntry('M ', 'ref/plans/other-id.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, deepInput);
    expect(result.ok).toBe(true); // 不命中
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('ref/plans/other-id.md');
  });
});

describe('assertMainRepoCleanForArchive — NUL 分隔 parser 边界 (R2 MED-C)', () => {
  it('含空格 path 用 NUL 分隔正确解析（newline-split parser 会漏）', async () => {
    // path 含空格：'src/path with space.md'
    const stdout = nulEntry('M ', 'src/path with space.md');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true); // 不命中 critical
    expect(result.warnings).toEqual([{ path: 'src/path with space.md', status: 'M ' }]);
  });

  it('多 entry 连续 NUL 分隔正确解析所有', async () => {
    // 3 个 entry 不命中 critical
    const stdout =
      nulEntry('M ', 'src/a.ts') +
      nulEntry(' M', 'src/b.ts') +
      nulEntry('??', 'src/c.ts');
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(3);
  });

  it('rename 第二段 NUL 缺失（malformed） → parser 不挂 + 不识别 oldname', async () => {
    // 异常输入：R 类型只有一段 NUL — 防御性处理
    const stdout = `R  src/new-name.ts\0`; // 只有 newname,无 oldname NUL trailer
    const runGit = vi.fn().mockResolvedValue(stdout);
    const result = await assertMainRepoCleanForArchive({ runGit }, fixedInput);
    // parser break loop（找不到第二段 NUL）→ 第一段当作普通 entry 处理
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe('src/new-name.ts');
    expect(result.warnings[0].status).toBe('R ');
  });
});
