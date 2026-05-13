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
    // git 调用顺序（按 impl 内 runGit 调用顺序）：
    //   1. rev-parse --git-common-dir → /Users/test/repo/.git
    //   2. rev-parse --abbrev-ref HEAD → "worktree-mcp-bug-fix"
    //   3. status --porcelain → "" (clean)
    //   4. merge --ff-only worktree-mcp-bug-fix → "" (or any stdout)
    //   5. rev-parse HEAD → "deadbeef123"
    //   6. add <files...> → ""
    //   7. commit -m ... → ""
    //   8. worktree remove ... → ""
    //   9. branch -D worktree-mcp-bug-fix → ""
    const deps = makeDeps(state, [
      `${expectedMainRepo}/.git`,
      'worktree-mcp-bug-fix',
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

    // git 调用次数严格 9 次（happy path 完整）
    expect(state.gitCalls.length).toBe(9);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
    expect(state.gitCalls[0]?.cwd).toBe(input.worktreePath);
    expect(state.gitCalls[3]?.args).toEqual(['merge', '--ff-only', 'worktree-mcp-bug-fix']);
    expect(state.gitCalls[3]?.cwd).toBe(expectedMainRepo);
    expect(state.gitCalls[6]?.args[0]).toBe('commit');
    expect(state.gitCalls[7]?.args).toEqual(['worktree', 'remove', input.worktreePath]);
    expect(state.gitCalls[8]?.args).toEqual(['branch', '-D', 'worktree-mcp-bug-fix']);

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

// ─── CHANGELOG_99 archive caller (与 K2 baton 同款语义) ──────────────────

describe('archivePlanHandler — CHANGELOG_99 archive caller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 用 fixtureHappyPath 拼出能让 impl 真跑过 happy path 的 fixture(9 次 git 调用 + plan
  // 文件读 + writes + unlinks)。然后通过 handler 调用,验证 archive caller 三态。
  function makeHandlerStub(implWillSucceed: boolean): {
    implDeps: ArchivePlanDeps;
    workArgs: { plan_id: string; worktree_path: string; base_branch: string };
  } {
    const { state, input } = fixtureHappyPath();
    const gitStdouts = implWillSucceed
      ? [
          `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`, // git-common-dir
          'worktree-mcp-bug-fix-20260513', // abbrev-ref HEAD
          '', // status --porcelain (clean)
          '', // merge --ff-only
          'deadbeef123', // rev-parse HEAD
          '', // add
          '', // commit
          '', // worktree remove
          '', // branch -D
        ]
      : [
          `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`,
          'worktree-mcp-bug-fix-20260513',
          'M  some-file.ts', // status --porcelain (dirty) → impl 报错短路
        ];
    const deps = makeDeps(state, gitStdouts);
    return {
      implDeps: deps,
      workArgs: {
        plan_id: input.planId,
        worktree_path: input.worktreePath,
        base_branch: input.baseBranch,
      },
    };
  }

  it('happy path:caller row 存在 → archive 成功 → archived=ok', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const archiveCalls: string[] = [];
    const mockArchive = vi.fn(async (sid: string) => {
      archiveCalls.push(sid);
    });

    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('ok');
    expect(archiveCalls).toEqual(['caller-sid']);

    sessionRepoGetSpy.mockRestore();
  });

  it('caller row 缺失 → archived=failed + console.warn,不阻塞 ok return', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation(() => null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('failed');
    expect(mockArchive).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot archive caller caller-sid: not in sessions table'),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('archive 抛错 → archived=failed + console.warn,不阻塞 ok return', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const mockArchive = vi.fn(async (_sid: string) => {
      throw new Error('simulated archive error (FK constraint / DB locked)');
    });
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive },
    );

    // K2 同款:archive 抛错不阻塞,return ok + archived='failed'
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('failed');
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('archive caller caller-sid failed:'),
      expect.any(Error),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('impl 失败短路(worktree dirty)→ 不调 archive caller(plan 收口本身没成功,语义上不该归档 caller)', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(false); // 让 impl 在 status 阶段报 dirty
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive },
    );

    expect(result.isError).toBe(true); // impl dirty 检测 → 报错短路
    expect(mockArchive).not.toHaveBeenCalled();

    sessionRepoGetSpy.mockRestore();
  });
});
