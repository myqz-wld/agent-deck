/**
 * archive_plan tool UX completing followup 20260515 守门测试
 * (plan archive-plan-tool-ux-followup-20260515 Phase 2.7a)。
 *
 * 范围:11 项 fix(双异构 reviewer 对抗 + 用户 sign-off 后实施)的守门 case + 三个 helper
 * 单测(escapeTableCell / formatChangelogCell / syncPlansIndex):
 * - (a) fallback 链加 ref/plans/ 中间档 → caller 不传 planFilePath 时 plan 在 ref/plans/ 能被找到
 * - (b) changelogId 单值 / csv 多值 → INDEX 第 3 列 markdown link 拼接
 * - (b) caller 不传 changelogId + 老 4 列 / 旧 2 列 / 新 append 三种降级行为(α + β fallback)
 * - (b) plansIndexAction 四态 enum(created / appended / updated / unchanged)
 * - (c) INDEX 4 列 header + 4 列 row canonical 格式
 * - (c) description / changelog 列 escape `|` + 换行
 * - HIGH-1 planFilePath stem != planId → impl 层 reject + clear hint(silent unlink 防线)
 * - HIGH-2 silent override warn → warnings 数组(双方独立 HIGH 共识 走 warn 而非 reject)
 * - (d) 7 phase 专用 phaseHint anchor(rev-parse-HEAD 已在 r33 测,这里测剩余 6 phase)
 *
 * 不真起 git / 不真碰 fs:复用 _setup.ts 的 makeState / makeDeps / fixtureHappyPath
 * (与 impl-core / impl-r33 / impl-ff-merge-body / handler 同款模式)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  archivePlanImpl,
  _isArchivePlanError,
  escapeTableCell,
  formatChangelogCell,
  syncPlansIndex,
  type PlansIndexAction,
} from '../tools/handlers/archive-plan-impl';
import type { ArchivePlanResult, ArchivePlanError } from '../tools/handlers/archive-plan-impl';
import { makeState, makeDeps, fixtureHappyPath } from './archive-plan/_setup';

// ─── (a) fallback 链 ref/plans/ 中间档 ───────────────────────────────────────

describe('archive-plan-tool-ux-followup-20260515 (a) fallback 链', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plan 在 <main-repo>/ref/plans/<id>.md (中间档) → fallback 命中,不再因找不到 reject', async () => {
    const state = makeState();
    const planId = 'in-plans-dir-stub';
    const worktreePath = '/Users/test/repo/.claude/worktrees/in-plans-dir-stub';
    const mainRepo = '/Users/test/repo';
    state.files.set(worktreePath, '__dir__');
    // **关键 case**:plan 直接放在 mainRepo/plans/(本项目实际惯例),.claude/plans/ 不存在
    const planArchivedPath = `${mainRepo}/ref/plans/${planId}.md`;
    state.files.set(
      planArchivedPath,
      [
        '---',
        `plan_id: ${planId}`,
        `worktree_path: ${worktreePath}`,
        'status: in_progress',
        '---',
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
      'finalhash',
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
    // 自归档:planFilePath === archivedPath → step 12 不应 unlink(避免删自己)
    expect(state.unlinks).not.toContain(planArchivedPath);
  });

  it('plan 在 .claude/plans/ AND ref/plans/ 双存 → fallback 链选 .claude/plans/(优先档)', async () => {
    const state = makeState();
    const planId = 'double-exist-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/double-exist-plan';
    const mainRepo = '/Users/test/repo';
    state.files.set(worktreePath, '__dir__');
    const projectLocalPath = `${mainRepo}/.claude/plans/${planId}.md`;
    const projectArchivedPath = `${mainRepo}/ref/plans/${planId}.md`;
    state.files.set(
      projectLocalPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'localBody'].join('\n'),
    );
    state.files.set(
      projectArchivedPath,
      ['---', `plan_id: ${planId}`, 'status: completed', '---', 'oldArchivedBody'].join('\n'),
    );

    const deps = makeDeps(state, [
      `${mainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
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
    // .claude/plans/ 优先 → 删 .claude/plans/ 那份;plans/ 那份被覆盖(HIGH-2 走 warn)
    expect(state.unlinks).toContain(projectLocalPath);
  });

  it('plan 三档全无 → reject + hint 含三条路径', async () => {
    const state = makeState();
    const input = {
      planId: 'truly-missing-plan',
      worktreePath: '/Users/test/repo/.claude/worktrees/truly-missing-plan',
      baseBranch: 'main',
    };
    state.files.set(input.worktreePath, '__dir__');
    const deps = makeDeps(state, ['/Users/test/repo/.git', 'wb', '']);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const hint = (result as ArchivePlanError).hint!;
    expect(hint).toContain('/Users/test/repo/.claude/plans');
    expect(hint).toContain('/Users/test/repo/ref/plans');
    expect(hint).toContain('/Users/test/.claude/plans');
  });
});

// ─── HIGH-1 planFilePath stem != planId ────────────────────────────────

describe('archive-plan-tool-ux-followup-20260515 HIGH-1 planFilePath stem refine', () => {
  it('planFilePath stem != planId → impl 层 reject + clear hint(silent unlink 防线)', async () => {
    const state = makeState();
    const planId = 'real-plan-id';
    const customPath = '/Users/test/some-location/wrong-stem.md';
    state.files.set(
      customPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );
    const worktreePath = '/Users/test/repo/.claude/worktrees/real-plan-id';
    state.files.set(worktreePath, '__dir__');

    const deps = makeDeps(state, ['/Users/test/repo/.git', 'wb', '']);
    const result = await archivePlanImpl(
      {
        planId,
        worktreePath,
        baseBranch: 'main',
        planFilePathOverride: customPath,
      },
      deps,
    );
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('planFilePath stem "wrong-stem"');
    expect(err.error).toContain(`planId "${planId}"`);
    expect(err.hint).toContain(`<main-repo>/ref/plans/${planId}.md`);
    expect(err.hint).toContain('silently move');
    // 防 silent unlink:caller 文件 wrong-stem.md 不应被删
    expect(state.unlinks).not.toContain(customPath);
  });

  it('planFilePath stem == planId → 正常放行(stem refine 不拦合法用法)', async () => {
    const state = makeState();
    const planId = 'override-plan-good';
    const customPath = `/Users/test/some-location/${planId}.md`;
    state.files.set(
      customPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );
    const worktreePath = '/Users/test/repo/.claude/worktrees/override-plan-good';
    state.files.set(worktreePath, '__dir__');

    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
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
  });
});

// ─── HIGH-2 silent override warn ─────────────────────────────────────────

describe('archive-plan-tool-ux-followup-20260515 HIGH-2 silent override warn', () => {
  it('plan 在 .claude/plans/ + ref/plans/ 已有同 id 历史归档 → warnings 含 silent-override', async () => {
    const state = makeState();
    const planId = 'overwrite-target-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/overwrite-target-plan';
    const mainRepo = '/Users/test/repo';
    state.files.set(worktreePath, '__dir__');
    const projectLocalPath = `${mainRepo}/.claude/plans/${planId}.md`;
    const projectArchivedPath = `${mainRepo}/ref/plans/${planId}.md`;
    state.files.set(
      projectLocalPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'newBody'].join('\n'),
    );
    state.files.set(
      projectArchivedPath,
      ['---', `plan_id: ${planId}`, 'status: completed', '---', 'historicalArchive'].join('\n'),
    );

    const deps = makeDeps(state, [
      `${mainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
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
    // **不 reject**(用户决策 Q1 不 reject 只 warn)
    expect(_isArchivePlanError(result)).toBe(false);
    const ok = result as ArchivePlanResult;
    expect(ok.warnings.length).toBeGreaterThan(0);
    const overrideWarn = ok.warnings.find((w) => w.includes('silent-override'));
    expect(overrideWarn).toBeTruthy();
    expect(overrideWarn).toContain(projectLocalPath);
    expect(overrideWarn).toContain(projectArchivedPath);
  });

  it('plan 自归档(planFilePath === archivedPath) → 不应触发 silent-override warn', async () => {
    const state = makeState();
    const planId = 'self-archive-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/self-archive-plan';
    const mainRepo = '/Users/test/repo';
    state.files.set(worktreePath, '__dir__');
    const planArchivedPath = `${mainRepo}/ref/plans/${planId}.md`;
    state.files.set(
      planArchivedPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );

    const deps = makeDeps(state, [
      `${mainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
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
    const ok = result as ArchivePlanResult;
    // CHANGELOG_169 F2/F7: fixture frontmatter 无 worktreePath → soft warn push;branch 名不
    // 符 enter_worktree 约定 → soft warn push。核心契约 silent-override warn 不应出现即可。
    const silentOverrideWarn = ok.warnings.find((w) => w.includes('silent override'));
    expect(silentOverrideWarn).toBeUndefined();
  });
});

// ─── (b) changelogId + (c) 4 列 + smart update ───────────────────────────

describe('archive-plan-tool-ux-followup-20260515 (b)+(c) changelogId + INDEX 4 列', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caller 传 changelogId 单值 "122" → INDEX 4 列 row 第 3 列含 [122](../changelogs/CHANGELOG_122.md)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
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
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(
      { ...input, changelogId: '122' },
      deps,
    );
    expect(_isArchivePlanError(result)).toBe(false);
    const indexPath = path.join(expectedMainRepo, 'ref', 'plans', 'INDEX.md');
    const indexWrite = state.writes.find((w) => w.path === indexPath);
    expect(indexWrite!.content).toContain('[122](../changelogs/CHANGELOG_122.md)');
  });

  it('caller 传 changelogId csv "121,122" → INDEX 第 3 列含两个 link 用 ` / ` 分隔', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
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
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(
      { ...input, changelogId: '121,122' },
      deps,
    );
    expect(_isArchivePlanError(result)).toBe(false);
    const indexPath = path.join(expectedMainRepo, 'ref', 'plans', 'INDEX.md');
    const indexWrite = state.writes.find((w) => w.path === indexPath);
    expect(indexWrite!.content).toContain(
      '[121](../changelogs/CHANGELOG_121.md) / [122](../changelogs/CHANGELOG_122.md)',
    );
  });

  it('caller 不传 changelogId + INDEX 已有 4 列 row 含 changelog 链接 → smart update 保留原 changelog 列(α fallback)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'ref', 'plans', 'INDEX.md');
    state.files.set(
      indexPath,
      `# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [${input.planId}.md](${input.planId}.md) | in_progress | [99](../changelogs/CHANGELOG_99.md) | stub desc |\n`,
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
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).plansIndexAction).toBe('updated');
    const indexWrite = state.writes.find((w) => w.path === indexPath);
    // 原 changelog 列 [99] 应保留,而非清空成 `—`
    expect(indexWrite!.content).toContain('[99](../changelogs/CHANGELOG_99.md)');
    // status 列改成 completed
    expect(indexWrite!.content).toMatch(
      new RegExp(`\\| \\[${input.planId}\\.md\\]\\(${input.planId}\\.md\\) \\| completed \\|`),
    );
  });

  it('caller 不传 changelogId + INDEX 已有旧 2 列 row → smart update 升级为 4 列 + changelog 列用 `—` placeholder(β fallback)', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'ref', 'plans', 'INDEX.md');
    // 老 2 列 row(archive_plan 老版本生成的格式)
    state.files.set(
      indexPath,
      `# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [${input.planId}.md](${input.planId}.md) | older 2-col stub |\n`,
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
      'archivehash',
      '',
      '',
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect((result as ArchivePlanResult).plansIndexAction).toBe('updated');
    const indexWrite = state.writes.find((w) => w.path === indexPath);
    // 升级为 4 列,changelog 列用 `—` placeholder
    expect(indexWrite!.content).toMatch(
      new RegExp(`\\| \\[${input.planId}\\.md\\]\\(${input.planId}\\.md\\) \\| completed \\| — \\|`),
    );
  });

  it('plansIndexAction = unchanged 路径(idempotent re-archive,内容完全一致 → 不 write)', async () => {
    // 直接单测 syncPlansIndex helper 该路径(impl 端 unchanged 罕见,直接走 helper 测)
    const result = syncPlansIndex(
      `# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [foo.md](foo.md) | completed | — | hello |\n`,
      { planId: 'foo', description: 'hello', changelogCell: null },
    );
    expect(result.action).toBe('unchanged');
  });
});

// ─── helper unit tests ────────────────────────────────────────────────

describe('escapeTableCell helper', () => {
  it('plain string → 不变', () => {
    expect(escapeTableCell('hello world')).toBe('hello world');
  });

  it('含 `|` → 转义为 `\\|`', () => {
    expect(escapeTableCell('a|b|c')).toBe('a\\|b\\|c');
  });

  it('含换行(\\n / \\r\\n) → 替换为空格', () => {
    expect(escapeTableCell('line1\nline2')).toBe('line1 line2');
    expect(escapeTableCell('a\r\nb')).toBe('a b');
  });

  it('含 `\\` → 先 escape backslash 再 escape pipe(避免 `\\|` 被破坏)', () => {
    expect(escapeTableCell('a\\b|c')).toBe('a\\\\b\\|c');
  });
});

describe('formatChangelogCell helper', () => {
  it('undefined → null', () => {
    expect(formatChangelogCell(undefined)).toBeNull();
  });

  it('空串 → null', () => {
    expect(formatChangelogCell('')).toBeNull();
  });

  it('单值 "122" → markdown link', () => {
    expect(formatChangelogCell('122')).toBe('[122](../changelogs/CHANGELOG_122.md)');
  });

  it('csv 多值 "121,122" → 两个 link 用 ` / ` 分隔', () => {
    expect(formatChangelogCell('121,122')).toBe(
      '[121](../changelogs/CHANGELOG_121.md) / [122](../changelogs/CHANGELOG_122.md)',
    );
  });

  it('csv 含空白 " 121 , 122 " → trim 后正常拼接', () => {
    expect(formatChangelogCell(' 121 , 122 ')).toBe(
      '[121](../changelogs/CHANGELOG_121.md) / [122](../changelogs/CHANGELOG_122.md)',
    );
  });

  it('全空白 csv ", , ," → 过滤空段后 null', () => {
    expect(formatChangelogCell(', , ,')).toBeNull();
  });
});

describe('syncPlansIndex helper', () => {
  it('existing=null → action=created + 4 列 header + 4 列 row', () => {
    const result = syncPlansIndex(null, {
      planId: 'foo',
      description: 'hello',
      changelogCell: '[1](../changelogs/CHANGELOG_1.md)',
    });
    expect(result.action).toBe('created');
    expect(result.newContent).toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
    expect(result.newContent).toContain(
      '| [foo.md](foo.md) | completed | [1](../changelogs/CHANGELOG_1.md) | hello |',
    );
  });

  it('existing 不含 planId → action=appended + 4 列 row', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [other.md](other.md) | completed | — | other |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'hello',
      changelogCell: null,
    });
    expect(result.action).toBe('appended');
    expect(result.newContent).toContain('[other.md]'); // 老 row 保留
    expect(result.newContent).toContain('| [foo.md](foo.md) | completed | — | hello |');
  });

  it('existing 含 planId 旧 2 列 → action=updated 升级为 4 列', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [foo.md](foo.md) | old desc |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'new desc',
      changelogCell: null,
    });
    expect(result.action).toBe('updated');
    expect(result.newContent).toContain('| [foo.md](foo.md) | completed | — | new desc |');
    expect(result.newContent).not.toContain('| old desc |');
  });

  it('existing 含 planId 老 4 列 + caller 不传 changelog → 保留原 changelog 列', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [foo.md](foo.md) | in_progress | [99](../changelogs/CHANGELOG_99.md) | old desc |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'new desc',
      changelogCell: null,
    });
    expect(result.action).toBe('updated');
    expect(result.newContent).toContain('[99](../changelogs/CHANGELOG_99.md)'); // 保留
    expect(result.newContent).toContain('completed'); // status 改
    expect(result.newContent).toContain('new desc'); // description 改
  });

  it('existing 含 planId + caller 传新 changelog → 覆盖原 changelog', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [foo.md](foo.md) | in_progress | [99](../changelogs/CHANGELOG_99.md) | old |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'new',
      changelogCell: '[122](../changelogs/CHANGELOG_122.md)',
    });
    expect(result.action).toBe('updated');
    expect(result.newContent).toContain('[122](../changelogs/CHANGELOG_122.md)');
    expect(result.newContent).not.toContain('[99]');
  });

  it('regex 锚定行首,description 含同款 substring 不误命中', () => {
    // 描述列引用其他 plan 的 link,不应被当成 planId 行
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n' +
      '| [other.md](other.md) | completed | — | refers (foo.md) in description |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'real',
      changelogCell: null,
    });
    // 应识别为「foo 不在 INDEX」→ append 新行,而非误命中 other.md 那行
    expect(result.action).toBe('appended');
    expect(result.newContent).toContain('refers (foo.md) in description'); // 老 row 不动
    expect(result.newContent).toContain('| [foo.md](foo.md) | completed | — | real |');
  });

  it('planId 含 regex 特殊字符(`.`)→ 正确 escape,精确匹配', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n' +
      '| [foo.md](foo.md) | completed | — | foo |\n';
    // planId "fooXmd" 不应匹配到 "foo.md" 这行(`.` 是 regex 通配符若不 escape 会误命中)
    const result = syncPlansIndex(existing, {
      planId: 'fooXmd',
      description: 'new',
      changelogCell: null,
    });
    expect(result.action).toBe('appended');
  });
});

// ─── (d) 7 phase phaseHint anchor(rev-parse-HEAD 已在 r33 测,这里覆盖剩余 6 phase) ─────

describe('archive-plan-tool-ux-followup-20260515 (d) 7 phase phaseHint anchor', () => {
  it('mkdir-plans-dir 失败 → 专用 hint 含 "mkdir -p" + "idempotent"', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
    ]);
    // 在 mkdir 时抛错
    const wrappedDeps = {
      ...deps,
      mkdir: async (_p: string) => {
        throw new Error('EACCES: permission denied');
      },
    };
    const result = await archivePlanImpl(input, wrappedDeps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:mkdir-plans-dir]');
    expect(err.hint).toContain('mkdir -p');
    expect(err.hint).toContain('idempotent');
  });

  it('write-archived-plan 失败 → 专用 hint 含 "frontmatter: status=completed" + "final_commit"', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
    ]);
    // mkdir 正常,writeFile 抛错
    const wrappedDeps = {
      ...deps,
      writeFile: async (_p: string, _c: string) => {
        throw new Error('ENOSPC: no space');
      },
    };
    const result = await archivePlanImpl(input, wrappedDeps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:write-archived-plan]');
    expect(err.hint).toContain('status=completed');
    expect(err.hint).toContain('final_commit=');
  });

  it('sync-plans-INDEX 失败 → 专用 hint 含「4-column row」+ canonical 4 列示例', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
    ]);
    // mkdir + writeFile(archived) 正常,但 INDEX 写错
    let writeCallCount = 0;
    const wrappedDeps = {
      ...deps,
      writeFile: async (p: string, c: string) => {
        writeCallCount++;
        if (writeCallCount === 1) {
          // 第一次写是 archived plan,正常
          state.writes.push({ path: p, content: c });
          state.files.set(p, c);
          return;
        }
        // 第二次是 INDEX,抛错
        throw new Error('EROFS: read-only fs');
      },
    };
    const result = await archivePlanImpl(input, wrappedDeps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:sync-plans-INDEX]');
    expect(err.hint).toContain('4-column row');
    expect(err.hint).toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
  });

  it('unlink-original-plan 失败 → 专用 hint 含 "rm" + "skip if file is already gone"', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
    ]);
    const wrappedDeps = {
      ...deps,
      unlink: async (_p: string) => {
        throw new Error('EACCES: permission denied');
      },
    };
    const result = await archivePlanImpl(input, wrappedDeps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:unlink-original-plan]');
    expect(err.hint).toContain('rm ');
    expect(err.hint).toContain('skip if file is already gone');
  });

  it('git-add 失败 → 专用 hint 含 "git -C" + "git lock"', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'wb',
      '',
      'mainhash',
      '',
      '',
      'finalhash',
      new Error('error: pathspec did not match'),
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:git-add]');
    expect(err.hint).toContain('git lock');
    expect(err.hint).toContain(`git -C ${expectedMainRepo} add`);
  });

  it('git-commit 失败 → 专用 hint 含 "pre-commit hook" + "complete step 14"', async () => {
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
      new Error('error: pre-commit hook failed'),
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:git-commit]');
    expect(err.hint).toContain('pre-commit hook');
    expect(err.hint).toContain('complete step 14');
  });
});

// ─── return shape:plansIndexAction enum 类型校验 ─────────────────────────

describe('archive-plan-tool-ux-followup-20260515 return shape', () => {
  it('plansIndexAction 必须是 4 态 enum 之一(类型校验,不应为 boolean)', () => {
    const valid: PlansIndexAction[] = ['created', 'appended', 'updated', 'unchanged'];
    expect(valid.length).toBe(4);
  });
});

// ─── R1 fix: schema changelogId 校验入口 ──────────────────────────────────

describe('archive-plan-tool-ux-followup-20260515 R1 fix: changelogId schema 校验(zod)', () => {
  it('R1 fix codex LOW-2 / claude LOW-3:invalid changelogId "abc" → schema reject + 清晰错误信息', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    const result = schema.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      changelogId: 'abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('must be a digit');
    }
  });

  it('R1 fix codex LOW-2 / claude LOW-3:invalid changelogId "122,abc" → schema reject', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    const result = schema.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      changelogId: '122,abc',
    });
    expect(result.success).toBe(false);
  });

  it('R1 fix claude MED-3:放松 regex → "121, 122"(csv 含空格)合法,与 helper trim 行为对齐', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    const result = schema.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      changelogId: '121, 122',
    });
    expect(result.success).toBe(true);
  });

  it('R1 fix claude MED-3: " 122 "(单值前后有空格)合法', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    const result = schema.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      changelogId: ' 122 ',
    });
    expect(result.success).toBe(true);
  });

  it('valid changelogId "122"(单值) / "121,122"(csv 无空格) → 校验通过', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    expect(
      schema.safeParse({
        planId: 'foo',
        worktreePath: '/abs/path',
        changelogId: '122',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        planId: 'foo',
        worktreePath: '/abs/path',
        changelogId: '121,122',
      }).success,
    ).toBe(true);
  });

  it('omitted changelogId → 校验通过(optional)', async () => {
    const { z } = await import('zod');
    const { ARCHIVE_PLAN_SHAPE } = await import('../tools/schemas');
    const schema = z.object(ARCHIVE_PLAN_SHAPE);
    expect(
      schema.safeParse({
        planId: 'foo',
        worktreePath: '/abs/path',
      }).success,
    ).toBe(true);
  });
});

// ─── R1 fix: header upgrade(codex MED-1 旧 2 列 INDEX header → 4 列) ─────

describe('archive-plan-tool-ux-followup-20260515 R1 fix codex MED-1: 旧 2 列 INDEX header 升级 4 列', () => {
  it('syncPlansIndex existing 含老 2 列 header `| 文件 | 概要 |` + `|---|---|` → 自动升级为 4 列 canonical header', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [foo.md](foo.md) | old desc |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'new desc',
      changelogCell: null,
    });
    // header 必须升级为 4 列 canonical
    expect(result.newContent).toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
    expect(result.newContent).toContain('|------|------|---------------|------|');
    expect(result.newContent).not.toMatch(/^\| 文件 \| 概要 \|$/m);
  });

  it('syncPlansIndex existing 是 4 列 canonical header → idempotent no-op(不重复升级)', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n| [foo.md](foo.md) | completed | — | hello |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'hello',
      changelogCell: null,
    });
    expect(result.action).toBe('unchanged');
    expect(result.newContent).toBe(existing);
  });

  it('header upgrade + row 内容相同 → action=updated(因 header 真变了,语义 != unchanged)', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [foo.md](foo.md) | old |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'old',
      changelogCell: null,
    });
    // 即使 row 同 desc(carry-forward 老 description),header 升级也算 'updated'
    expect(result.action).toBe('updated');
    expect(result.newContent).toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
  });

  it('header upgrade + 新 planId 不在 INDEX → action=appended,4 列 row 挂在 4 列 header 下', () => {
    const existing =
      '# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [other.md](other.md) | other |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'foo desc',
      changelogCell: null,
    });
    expect(result.action).toBe('appended');
    expect(result.newContent).toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
    // 新 row 是 4 列(挂在升级后 4 列 header 下,渲染对齐)
    expect(result.newContent).toContain('| [foo.md](foo.md) | completed | — | foo desc |');
    // old 2 列 row 不动(只升级 header,不动其他 row 避免误改 caller 自定义)
    expect(result.newContent).toContain('| [other.md](other.md) | other |');
  });

  it('upgradeIndexHeader detect 保守:多列 header(≥3 列)不被误改', () => {
    // 用户自定义的 3 列 header 不应该被误识别为「老 2 列」
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 概要 |\n|------|------|------|\n| [foo.md](foo.md) | done | hello |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'hello',
      changelogCell: null,
    });
    // header 不应被改(原 3 列保留)
    expect(result.newContent).toContain('| 文件 | 状态 | 概要 |');
    expect(result.newContent).not.toContain('| 文件 | 状态 | 关联 changelog | 概要 |');
  });

  it('R2 codex LOW-2 / claude LOW-5: existing 4 列 row 的 description 含 escaped `\\|` → smart update 仍正确读 oldCols[2] changelog 列(invariant 守门 — 防未来扩展 oldCols[3+] 回归)', () => {
    // **invariant**:syncPlansIndex case 2 仅读 oldCols[2]=changelog 列在 description 之前,
    // description 含 escaped `\|` 被 naive split 误切只影响 oldCols[3+],不影响 changelog
    // fallback 路径。该 case 守门确认行为 + 警示后续扩展前必须先实现 escape-aware splitter。
    const existing =
      '# Plans 索引\n\n| 文件 | 状态 | 关联 changelog | 概要 |\n|------|------|---------------|------|\n' +
      '| [foo.md](foo.md) | in_progress | [99](../changelogs/CHANGELOG_99.md) | desc with a\\|b escaped pipe |\n';
    const result = syncPlansIndex(existing, {
      planId: 'foo',
      description: 'new clean desc',
      changelogCell: null,
    });
    expect(result.action).toBe('updated');
    // **关键**:即使老 description 列含 escaped `\|` 让 naive split 误切多段,
    // changelog 列(oldCols[2])仍正确保留为 [99](...)(因为 split 误切只影响 description 之后的列)
    expect(result.newContent).toContain('[99](../changelogs/CHANGELOG_99.md)');
    // 新 description 替换老的(不会因 escape 失败回退)
    expect(result.newContent).toContain('new clean desc');
    expect(result.newContent).not.toContain('escaped pipe'); // 老 desc 已被覆盖
  });
});

// ─── R1 fix: postFfMergeErr retry-invariant prefix(MED-2 共识) ──────────

describe('archive-plan-tool-ux-followup-20260515 R1 fix MED-2: postFfMergeErr retry-invariant prefix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('phaseHint 传入时 → hint 自动加 retry-invariant prefix「Cannot retry archive_plan as a whole」', async () => {
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
      new Error('error: pre-commit hook failed'),
    ]);
    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    const err = result as ArchivePlanError;
    expect(err.hint).toContain('Cannot retry archive_plan as a whole');
    expect(err.hint).toContain('DO NOT re-call archive_plan');
    // 仍含原 phaseHint 内容
    expect(err.hint).toContain('pre-commit hook');
  });

  it('phaseHint 缺省 → hint = GENERIC(GENERIC 自身已含 retry 警告,不重复 prefix)', async () => {
    // REVIEW_73 MED: 所有 impl postFfMergeErr 调用现都传 phaseHint(8b read-fail/no-fm 也补了
    // reset phaseHint),无 impl 路径再产生 GENERIC fallback。本 test 改为直接 unit-test
    // postFfMergeErr 的 GENERIC fallback 分支(phaseHint 缺省时),保留「GENERIC 不重复 prefix」
    // 契约验证(不再依赖已失效的 8b read-fail 触发路径)。
    const { postFfMergeErr } = await import('../tools/handlers/archive-plan-impl');
    const err = postFfMergeErr(
      'reread-plan-after-ffmerge',
      new Error('some failure'),
      // 不传 phaseHint → 走 GENERIC
    ) as ArchivePlanError;
    expect(err.error).toContain('[post-ff-merge:reread-plan-after-ffmerge]');
    // 不传 phaseHint → 走 GENERIC(自含 retry 警告)
    expect(err.hint).toContain('ff-merge 已完成');
    expect(err.hint).toContain('phase 标识手工补完');
    // GENERIC 不应被 prefix 重复(prefix 只加给 phaseHint override 路径)
    expect(err.hint).not.toContain('⚠ Cannot retry archive_plan as a whole');
  });
});
