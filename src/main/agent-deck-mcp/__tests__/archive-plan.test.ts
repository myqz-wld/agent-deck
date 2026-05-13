/**
 * archive_plan tool 单测（plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.4）。
 *
 * 双层覆盖：
 * 1. handler 入口（archive-plan.ts）：deny external caller；happy path 走通
 * 2. impl 业务（archive-plan-impl.ts）：deps inject mock 替换 git/fs，验证完整调用顺序 +
 *    预检失败分支（plan completed / cwd 在 worktree / worktree dirty / detached HEAD）+
 *    默认 plan 路径 fallback（先 main-repo/.claude/plans/ → ~/.claude/plans/）+ frontmatter
 *    更新 + INDEX append
 *
 * 不真起 git / 不真碰 fs：deps inject 替换全部副作用，跑纯 in-memory，与 tools.test.ts
 * 风格一致（vi.mock 风格不适合本场景：deps inject 更灵活、mock 更内聚）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  archivePlanImpl,
  type ArchivePlanDeps,
  type ArchivePlanResult,
  type ArchivePlanError,
  _isArchivePlanError,
} from '../tools/handlers/archive-plan-impl';

// ─── Test fixture: in-memory deps ────────────────────────────────────────

interface TestState {
  files: Map<string, string>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  unlinks: string[];
  mkdirs: string[];
  writes: Array<{ path: string; content: string }>;
  fakeCwd: string;
  fakeHomedir: string;
  realpathMap: Map<string, string>;
}

function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    files: new Map(),
    gitCalls: [],
    unlinks: [],
    mkdirs: [],
    writes: [],
    fakeCwd: '/Users/test/some-other-cwd',
    fakeHomedir: '/Users/test',
    realpathMap: new Map(), // canonical mapping; if missing, identity
    ...overrides,
  };
}

/**
 * 构造一份模拟 deps，按 state.files / fakeCwd / fakeHomedir 等驱动行为。
 *
 * gitMockPlan 是按调用顺序逐条返回的 stdout 队列（默认 trim）。
 */
function makeDeps(
  state: TestState,
  gitMockPlan: Array<string | Error>,
): ArchivePlanDeps {
  const queue = [...gitMockPlan];
  return {
    runGit: async (args: string[], cwd: string) => {
      state.gitCalls.push({ args, cwd });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`runGit mock exhausted at call ${state.gitCalls.length}: ${args.join(' ')}`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
    readFile: async (p) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: no mock file at ${p}`);
      return c;
    },
    writeFile: async (p, content) => {
      state.writes.push({ path: p, content });
      state.files.set(p, content);
    },
    unlink: async (p) => {
      state.unlinks.push(p);
      state.files.delete(p);
    },
    mkdir: async (p) => {
      state.mkdirs.push(p);
    },
    exists: async (p) => state.files.has(p),
    realpath: async (p) => state.realpathMap.get(p) ?? p,
    cwd: () => state.fakeCwd,
    homedir: () => state.fakeHomedir,
  };
}

// 标准 fixture：worktree clean + plan in_progress + cwd 在 worktree 外
function fixtureHappyPath(): {
  state: TestState;
  input: {
    planId: string;
    worktreePath: string;
    baseBranch: string;
  };
  expectedMainRepo: string;
  expectedArchivedPath: string;
} {
  const state = makeState();
  const planId = 'mcp-bug-fix-20260513';
  const worktreePath = '/Users/test/repo/.claude/worktrees/mcp-bug-fix-20260513';
  const mainRepo = '/Users/test/repo';
  // plan 文件在默认 main-repo/.claude/plans/ 路径
  const planFilePath = `${mainRepo}/.claude/plans/${planId}.md`;
  state.files.set(
    planFilePath,
    [
      '---',
      `plan_id: ${planId}`,
      'created_at: 2026-05-13',
      `worktree_path: ${worktreePath}`,
      'status: in_progress',
      'base_commit: abc123',
      '---',
      '',
      '# Plan body content',
      '',
      'Some details.',
    ].join('\n'),
  );
  return {
    state,
    input: { planId, worktreePath, baseBranch: 'main' },
    expectedMainRepo: mainRepo,
    expectedArchivedPath: path.join(mainRepo, 'plans', `${planId}.md`),
  };
}

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
    expect(ok.plansIndexAppended).toBe(true);
    expect(ok.finalStatus).toBe('completed');

    // git 调用次数严格 11 次（happy path 完整，REVIEW_33 H1 加了 verify + checkout）
    expect(state.gitCalls.length).toBe(11);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
    expect(state.gitCalls[0]?.cwd).toBe(input.worktreePath);
    // REVIEW_33 H1：verify base_branch 存在 + checkout 到 base_branch
    expect(state.gitCalls[3]?.args).toEqual(['rev-parse', '--verify', 'main']);
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

  it('INDEX 已存在 → append 一行（不重复 / 不重写 header）', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    state.files.set(
      indexPath,
      '# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [old-plan.md](old-plan.md) | older |\n',
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

    const indexWrite = state.writes.find((w) => w.path === indexPath);
    expect(indexWrite).toBeTruthy();
    // 旧条目保留 + 新条目追加
    expect(indexWrite!.content).toContain('[old-plan.md]');
    expect(indexWrite!.content).toContain(`[${input.planId}.md]`);
    // 没有重写 header（header 出现 1 次）
    expect((indexWrite!.content.match(/# Plans 索引/g) ?? []).length).toBe(1);
  });

  it('plan_id 已在 INDEX → 跳过 append（防重复 + plansIndexAppended=false）', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    const indexPath = path.join(expectedMainRepo, 'plans', 'INDEX.md');
    state.files.set(
      indexPath,
      `# Plans 索引\n\n| 文件 | 概要 |\n|---|---|\n| [${input.planId}.md](${input.planId}.md) | already here |\n`,
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
    expect((result as ArchivePlanResult).plansIndexAppended).toBe(false);

    // INDEX 没有第二次 write
    const indexWrites = state.writes.filter((w) => w.path === indexPath);
    expect(indexWrites.length).toBe(0);
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

  it('plan 文件不存在（默认两条路径都没找到）→ reject + 提示 hint 含两条 fallback 路径', async () => {
    const state = makeState();
    const input = {
      planId: 'no-such-plan',
      worktreePath: '/Users/test/repo/.claude/worktrees/no-such-plan',
      baseBranch: 'main',
    };
    const deps = makeDeps(state, [
      '/Users/test/repo/.git',
      'wb',
      '',
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('plan file not found');
    expect((result as ArchivePlanError).hint).toContain('.claude/plans');
    expect((result as ArchivePlanError).hint).toContain('/Users/test/.claude/plans');
  });
});

describe('archivePlanImpl — plan 文件路径 fallback', () => {
  it('main-repo/.claude/plans 不存在 → fallback 到 ~/.claude/plans', async () => {
    const state = makeState();
    const planId = 'global-plan';
    const worktreePath = '/Users/test/repo/.claude/worktrees/global-plan';
    const mainRepo = '/Users/test/repo';
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

  it('显式 plan_file_path override → 用之（覆盖默认 fallback）', async () => {
    const state = makeState();
    const planId = 'override-plan';
    const customPath = '/Users/test/some-custom-location/myplan.md';
    state.files.set(
      customPath,
      ['---', `plan_id: ${planId}`, 'status: in_progress', '---', 'body'].join('\n'),
    );
    const worktreePath = '/Users/test/repo/.claude/worktrees/override-plan';

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

  it('显式 plan_file_path override 不存在 → reject', async () => {
    const state = makeState();
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
    expect((result as ArchivePlanError).error).toContain('plan_file_path override does not exist');
  });
});

describe('archivePlanImpl — REVIEW_33 H1 base_branch checkout', () => {
  it('base_branch 真切：调用顺序含 rev-parse --verify <baseBranch> + checkout <baseBranch>', async () => {
    const { state, input, expectedMainRepo } = fixtureHappyPath();
    // 用 develop 作 base_branch（与 default 'main' 区分），确认 impl 真用 input.baseBranch
    const customInput = { ...input, baseBranch: 'develop' };
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
      '',
      'develophash', // rev-parse --verify develop 真返 hash
      '', // checkout develop
      '', // merge --ff-only
      'h',
      '',
      '',
      '',
      '',
    ]);

    const result = await archivePlanImpl(customInput, deps);
    expect(_isArchivePlanError(result)).toBe(false);
    expect(state.gitCalls[3]?.args).toEqual(['rev-parse', '--verify', 'develop']);
    expect(state.gitCalls[4]?.args).toEqual(['checkout', 'develop']);
    expect(state.gitCalls[4]?.cwd).toBe(expectedMainRepo);
    expect(state.gitCalls[5]?.args).toEqual(['merge', '--ff-only', 'worktree-mcp-bug-fix']);
  });

  it('base_branch 不存在 → rev-parse --verify throw → reject 提示 base_branch 缺失', async () => {
    const { state, input } = fixtureHappyPath();
    const deps = makeDeps(state, [
      `/Users/test/repo/.git`,
      'wb',
      '',
      new Error('fatal: Needed a single revision'),
    ]);

    const result = await archivePlanImpl(input, deps);
    expect(_isArchivePlanError(result)).toBe(true);
    expect((result as ArchivePlanError).error).toContain('base_branch "main" does not exist');
    // checkout / merge 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'checkout')).toBeUndefined();
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('checkout base_branch 失败 → reject + hint 提示 hooks/uncommitted', async () => {
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

describe('archivePlanImpl — REVIEW_33 H2 status 三档分流', () => {
  it('plan status = abandoned → reject + hint 引用 user CLAUDE.md §Step 4 abandoned cleanup', async () => {
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
    expect((result as ArchivePlanError).error).toContain('would pollute git history');
    expect((result as ArchivePlanError).hint).toContain('§Step 4 abandoned cleanup');
    expect((result as ArchivePlanError).hint).toContain('git worktree remove --force');
    // git merge / checkout 不应被调用（早返）
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
    expect(state.gitCalls.find((c) => c.args[0] === 'checkout')).toBeUndefined();
  });

  it('plan status = unknown 值（如 draft） → reject + hint 列出三档合法 status', async () => {
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
    expect((result as ArchivePlanError).error).toContain('only accepts "in_progress"');
    expect((result as ArchivePlanError).hint).toContain('Valid statuses');
    expect((result as ArchivePlanError).hint).toContain('in_progress');
    expect((result as ArchivePlanError).hint).toContain('completed');
    expect((result as ArchivePlanError).hint).toContain('abandoned');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });

  it('plan frontmatter 缺 status 字段 → reject (status 视为 unknown，hint 列三档)', async () => {
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
    expect((result as ArchivePlanError).hint).toContain('Valid statuses');
    expect(state.gitCalls.find((c) => c.args[0] === 'merge')).toBeUndefined();
  });
});
