/**
 * start_next_session tool 单测（plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.4）。
 *
 * 双层覆盖：
 * 1. impl 层（start-next-session-impl.ts）：deps inject mock fs + git，验证 plan 文件路径
 *    fallback（main-repo > user-global > 显式 override）+ frontmatter parse + status 校验
 *    （in_progress / completed / abandoned / missing）+ worktree_path 校验（缺失 / 非绝对）
 *    + phase_label prompt 注入
 * 2. handler 层（start-next-session.ts）：deny external caller + happy path 调 mock spawn
 *    handler 验证 K2 metadata 透传 + spawn 字段透传 + spawn 错误透传
 *
 * 不真起 git / 不真碰 fs / 不真起 SDK session：deps inject 替换全部副作用，跑纯 in-memory，
 * 与 archive-plan.test.ts 风格一致。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startNextSessionImpl,
  type StartNextSessionDeps,
  type StartNextSessionResolved,
  type StartNextSessionError,
  _isStartNextSessionError,
} from '../tools/handlers/start-next-session-impl';
import { startNextSessionHandler } from '../tools/handlers/start-next-session';
import type { StartNextSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';

// ─── Test fixture: in-memory deps ────────────────────────────────────────

interface TestState {
  files: Map<string, string>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
  fakeCwd: string;
  fakeHomedir: string;
  /** 设为 true 时 runGit 抛 error（模拟 caller cwd 非 git repo） */
  gitFails: boolean;
  /** runGit 返回的 git common dir（默认 `<mainRepo>/.git`） */
  gitCommonDir: string;
}

function makeState(overrides: Partial<TestState> = {}): TestState {
  return {
    files: new Map(),
    gitCalls: [],
    fakeCwd: '/Users/test/repo',
    fakeHomedir: '/Users/test',
    gitFails: false,
    gitCommonDir: '/Users/test/repo/.git',
    ...overrides,
  };
}

function makeDeps(state: TestState): StartNextSessionDeps {
  return {
    runGit: async (args: string[], cwd: string) => {
      state.gitCalls.push({ args, cwd });
      if (state.gitFails) {
        throw new Error('not a git repository');
      }
      // 仅支持 rev-parse --git-common-dir（impl 只调这一个 git 子命令）
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return state.gitCommonDir;
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    readFile: async (p) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: no mock file at ${p}`);
      return c;
    },
    exists: async (p) => state.files.has(p),
    cwd: () => state.fakeCwd,
    homedir: () => state.fakeHomedir,
  };
}

/** 构造一个标准 plan 文件 fixture（in_progress + worktree_path + base_branch） */
function planContent(opts: {
  planId?: string;
  worktreePath?: string;
  status?: string;
  baseBranch?: string;
  omitWorktreePath?: boolean;
  worktreePathRelative?: boolean;
}): string {
  const lines = ['---', `plan_id: ${opts.planId ?? 'test-plan'}`];
  if (!opts.omitWorktreePath) {
    const wp = opts.worktreePathRelative
      ? '.claude/worktrees/test-plan'
      : opts.worktreePath ?? '/Users/test/repo/.claude/worktrees/test-plan';
    lines.push(`worktree_path: ${wp}`);
  }
  if (opts.status !== undefined) {
    lines.push(`status: ${opts.status}`);
  }
  if (opts.baseBranch !== undefined) {
    lines.push(`base_branch: ${opts.baseBranch}`);
  }
  lines.push('---', '', '# Plan body', '');
  return lines.join('\n');
}

describe('startNextSessionImpl — happy path', () => {
  it('完整 happy path：caller cwd 反查 main-repo → main-repo/.claude/plans/ 命中 → 返回 resolved', async () => {
    const state = makeState();
    const planId = 'test-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', baseBranch: 'main' }),
    );

    const result = await startNextSessionImpl({ planId }, makeDeps(state));

    expect(_isStartNextSessionError(result)).toBe(false);
    const ok = result as StartNextSessionResolved;
    expect(ok.planFilePath).toBe(planFilePath);
    expect(ok.worktreePath).toBe('/Users/test/repo/.claude/worktrees/test-plan');
    expect(ok.coldStartPrompt).toBe(`按 ${planFilePath} 接力`);
    expect(ok.baseBranch).toBe('main');
    // git 只调 1 次（rev-parse --git-common-dir）
    expect(state.gitCalls.length).toBe(1);
    expect(state.gitCalls[0]?.args).toEqual(['rev-parse', '--git-common-dir']);
  });

  it('phase_label 注入 prompt 后缀', async () => {
    const state = makeState();
    const planId = 'test-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl(
      { planId, phaseLabel: 'H3 Phase 4b' },
      makeDeps(state),
    );

    expect(_isStartNextSessionError(result)).toBe(false);
    const ok = result as StartNextSessionResolved;
    expect(ok.coldStartPrompt).toBe(`按 ${planFilePath} 接力（Phase: H3 Phase 4b）`);
  });

  it('main-repo 反查失败（caller cwd 非 git）→ fallback 到 ~/.claude/plans/', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'global-plan';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    state.files.set(userGlobalPath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));

    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).planFilePath).toBe(userGlobalPath);
  });

  it('main-repo 反查成功但 main-repo/.claude/plans/ 不存在 → fallback 到 ~/.claude/plans/', async () => {
    const state = makeState();
    const planId = 'cross-project-plan';
    const userGlobalPath = `/Users/test/.claude/plans/${planId}.md`;
    state.files.set(userGlobalPath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));

    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).planFilePath).toBe(userGlobalPath);
  });

  it('显式 plan_file_path override → 用之（绕过 fallback）', async () => {
    const state = makeState();
    const planId = 'override-plan';
    const customPath = '/Users/test/some-custom-location/myplan.md';
    state.files.set(customPath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl(
      { planId, planFilePathOverride: customPath },
      makeDeps(state),
    );

    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).planFilePath).toBe(customPath);
    // git 不应被调（显式 override 绕过 main-repo 反查）
    expect(state.gitCalls.length).toBe(0);
  });

  it('git rev-parse 返回相对路径 → 按 caller cwd resolve 成绝对', async () => {
    const state = makeState({
      gitCommonDir: '.git', // 相对路径
      fakeCwd: '/Users/test/repo',
    });
    const planId = 'relative-git';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).planFilePath).toBe(planFilePath);
  });
});

describe('startNextSessionImpl — 校验失败分支', () => {
  it('plan 文件不存在（默认两层都没找到）→ reject + hint 含两条路径', async () => {
    const state = makeState();
    const planId = 'no-such-plan';

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    const err = result as StartNextSessionError;
    expect(err.error).toContain('plan file not found');
    expect(err.hint).toContain('/Users/test/repo/.claude/plans');
    expect(err.hint).toContain('/Users/test/.claude/plans');
  });

  it('plan 文件不存在（git 失败 → 只走 user-global）→ hint 提示跳过 main-repo', async () => {
    const state = makeState({ gitFails: true });
    const planId = 'no-such-plan';

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    const err = result as StartNextSessionError;
    expect(err.hint).toContain('not a git repo');
    expect(err.hint).toContain('/Users/test/.claude/plans');
  });

  it('显式 plan_file_path override 不存在 → reject', async () => {
    const state = makeState();
    const result = await startNextSessionImpl(
      { planId: 'whatever', planFilePathOverride: '/no/such/path.md' },
      makeDeps(state),
    );
    expect(_isStartNextSessionError(result)).toBe(true);
    expect((result as StartNextSessionError).error).toContain(
      'plan_file_path override does not exist',
    );
  });

  it('plan 文件无 frontmatter → reject', async () => {
    const state = makeState();
    const planId = 'no-fm';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, '# Just a markdown body, no frontmatter\n');

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    expect((result as StartNextSessionError).error).toContain('no parseable frontmatter');
  });

  it('frontmatter 缺 worktree_path → reject', async () => {
    const state = makeState();
    const planId = 'missing-wp';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', omitWorktreePath: true }),
    );

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    expect((result as StartNextSessionError).error).toContain('missing required field: worktree_path');
  });

  it('frontmatter worktree_path 非绝对路径 → reject', async () => {
    const state = makeState();
    const planId = 'rel-wp';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePathRelative: true }),
    );

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    expect((result as StartNextSessionError).error).toContain('must be absolute');
  });

  it('plan status = completed → reject + 提示已归档', async () => {
    const state = makeState();
    const planId = 'done-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'completed' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    const err = result as StartNextSessionError;
    expect(err.error).toContain('"completed"');
    expect(err.hint).toContain('in-progress plans');
  });

  it('plan status = abandoned → reject + 提示中止 plan', async () => {
    const state = makeState();
    const planId = 'gone-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'abandoned' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    const err = result as StartNextSessionError;
    expect(err.error).toContain('"abandoned"');
    expect(err.hint).toContain('Abandoned');
  });

  it('plan status missing → reject + 提示加 in_progress', async () => {
    const state = makeState();
    const planId = 'no-status';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId })); // 不传 status

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(true);
    const err = result as StartNextSessionError;
    expect(err.error).toContain('<missing>');
  });
});

describe('startNextSessionImpl — base_branch 透传', () => {
  it('frontmatter 含 base_branch → resolved.baseBranch 透传', async () => {
    const state = makeState();
    const planId = 'with-base';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', baseBranch: 'develop' }),
    );

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).baseBranch).toBe('develop');
  });

  it('frontmatter 无 base_branch → resolved.baseBranch = null', async () => {
    const state = makeState();
    const planId = 'no-base';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const result = await startNextSessionImpl({ planId }, makeDeps(state));
    expect(_isStartNextSessionError(result)).toBe(false);
    expect((result as StartNextSessionResolved).baseBranch).toBeNull();
  });
});

// ─── Handler 层测试 ────────────────────────────────────────────────────

describe('startNextSessionHandler — deny external caller', () => {
  it('caller_session_id = __external__ + transport=stdio → 拒绝', async () => {
    const args: StartNextSessionArgs = {
      plan_id: 'whatever',
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: '__external__',
        transport: 'stdio',
      },
    };

    const result = await startNextSessionHandler(args, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
  });
});

describe('startNextSessionHandler — happy path with mock spawn', () => {
  it('调 spawn handler + 透传 K2 metadata + 透传 spawn 字段 + 归档 caller', async () => {
    const state = makeState();
    const planId = 'happy-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );

    // mock spawnSessionHandler 返回 ok({ sessionId: 'fake-sid', ... })
    // CHANGELOG_97：team 字段 default null（K2 不再默认设 team_name）
    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'fake-sid',
              adapter: 'claude-code',
              cwd: worktreePath,
              teamId: null,
              teamName: null,
              agentName: null,
              displayName: null,
              spawnDepth: 1,
              sentAt: 1234567890,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
    // CHANGELOG_97：archive caller seam，记录调用 sid
    const archiveCalls: string[] = [];
    const mockArchive = vi.fn(async (sid: string) => {
      archiveCalls.push(sid);
    });

    const args: StartNextSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      phase_label: 'H3 phase 4b',
    };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: 'caller-sid',
        transport: 'in-process',
      },
    };

    // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 修法后 archive 前会 sessionRepo.get
    // 探针，缺 row → 'failed' 不调 archive。本 case 测正常 archive 路径，所以 spy
    // 让 caller-sid 有 fake row。
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

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    // K2 metadata
    expect(data.planId).toBe(planId);
    expect(data.planFilePath).toBe(planFilePath);
    expect(data.worktreePath).toBe(worktreePath);
    expect(data.baseBranch).toBe('main');
    expect(data.phaseLabel).toBe('H3 phase 4b');
    expect(data.initialPrompt).toBe(`按 ${planFilePath} 接力（Phase: H3 phase 4b）`);
    // spawn 透传（CHANGELOG_97：team 字段全 null）
    expect(data.sessionId).toBe('fake-sid');
    expect(data.adapter).toBe('claude-code');
    expect(data.cwd).toBe(worktreePath);
    expect(data.teamId).toBeNull();
    expect(data.teamName).toBeNull();
    expect(data.spawnPromptMessageId).toBeNull();
    // CHANGELOG_98 / Phase A5 / R2 反馈：archived 三态字段断言（'ok' / 'failed' / 'skipped'）
    expect(data.archived).toBe('ok');

    // spawn 调用参数：cwd 默认 worktree_path，**default 不传 team_name**（CHANGELOG_97），
    // prompt 是 cold-start
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    expect(spawnArgs.cwd).toBe(worktreePath);
    expect(spawnArgs.team_name).toBeUndefined();
    expect(spawnArgs.adapter).toBe('claude-code');
    expect(spawnArgs.prompt).toBe(`按 ${planFilePath} 接力（Phase: H3 phase 4b）`);

    // CHANGELOG_97：archive caller 默认被调用，sid = caller.callerSessionId
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(archiveCalls).toEqual(['caller-sid']);

    sessionRepoGetSpy.mockRestore();
  });

  it('caller 显式 cwd / team_name → 透传给 spawn（不被 default 覆盖）', async () => {
    const state = makeState();
    const planId = 'override-test';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 's', adapter: 'claude-code', cwd: '/x', teamName: 'custom-team' }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: StartNextSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      cwd: '/Users/test/some-other-cwd',
      team_name: 'custom-team',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 探针需 caller-sid 有 row
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

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    const data = JSON.parse(result.content[0]!.text);
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    expect(spawnArgs.cwd).toBe('/Users/test/some-other-cwd');
    expect(spawnArgs.team_name).toBe('custom-team');
    // CHANGELOG_97：显式传 team_name 时仍归档 caller（baton 语义与是否启用 team 通信关系正交）
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');

    sessionRepoGetSpy.mockRestore();
  });

  it('CHANGELOG_97: archive caller 失败 → warn-only 不阻塞 K2 成功 return', async () => {
    const state = makeState();
    const planId = 'archive-fails';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 'newsid', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => {
      throw new Error('simulated archive error (e.g. session row already deleted)');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const args: StartNextSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 探针需 caller-sid 有 row（让 archive
    // 真被调用，模拟 archive 内部抛错的 'failed' 路径，而非 row missing 的 'failed'）
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

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    // K2 成功 return 不被 archive 错误阻塞
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.sessionId).toBe('newsid');
    // CHANGELOG_98：archive throw → archived='failed'（与 row missing 路径同状态值不同来源）
    expect(data.archived).toBe('failed');
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('archive caller caller-sid failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 新增 case — caller row missing（session
  // 异常被清理 / 边界状态）→ archived='failed' + warn + mockArchive 不调用
  it('CHANGELOG_98: caller row missing → archived=failed + 不调 archive + warn', async () => {
    const state = makeState();
    const planId = 'caller-row-missing';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 'newsid', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const args: StartNextSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'ghost-caller-sid', transport: 'in-process' },
    };

    // sessionRepo.get(ghost-caller-sid) → null（caller row 不存在 = F1 探针挡）
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation(() => null);

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    // K2 仍 ok return（不阻塞，与 archive throw 同款）
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.sessionId).toBe('newsid');
    // F1 关键：archived='failed' (row missing 路径)
    expect(data.archived).toBe('failed');
    // F1 关键：archive 函数不被调用（探针在 archive 之前 short-circuit）
    expect(mockArchive).not.toHaveBeenCalled();
    // F1 关键：warn 含 row missing 提示
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot archive caller ghost-caller-sid'),
    );

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('spawn handler 返回 isError → 直接透传不二次包装 + archive 不被调用', async () => {
    const state = makeState();
    const planId = 'spawn-fail';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    state.files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'fan-out limit reached', hint: 'wait or shutdown a child' }),
          },
        ],
        isError: true as const,
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: StartNextSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('fan-out limit reached');
    // 不应嵌套包装（如 "start_next_session error: spawn error: ..."）
    expect(result.content[0]!.text).not.toContain('start_next_session');
    // CHANGELOG_97：spawn 失败 → 不归档 caller（没接到新 baton 不该让原会话退出）
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it('impl 错误（plan 文件不存在）→ err 不调 spawn + archive 不被调用', async () => {
    const state = makeState();
    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [{ type: 'text' as const, text: '{}' }],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: StartNextSessionArgs = {
      plan_id: 'no-such-plan',
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('plan file not found');
    expect(mockSpawn).not.toHaveBeenCalled();
    // CHANGELOG_97：plan 解析失败 → 既不 spawn 也不归档（baton 还没出手）
    expect(mockArchive).not.toHaveBeenCalled();
  });
});

describe('startNextSessionHandler — caller cwd 反查（plan mcp-handoff-fix-and-skill-timer-20260514 Phase A1）', () => {
  it('caller 不显式传 implDeps.cwd → handler 从 sessionRepo 反查 callerSession.cwd 注入到 impl', async () => {
    const planId = 'sessionrepo-injection';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const callerSid = 'caller-with-cwd-in-repo';
    const callerCwd = '/Users/test/repo'; // sessionRepo 反查给 impl 的 cwd
    const fakeHomedir = '/Users/test';

    // mock sessionRepo.get：caller-with-cwd-in-repo → cwd = '/Users/test/repo'
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === callerSid) {
        return {
          id: callerSid,
          adapter: 'claude-code',
          cwd: callerCwd,
          title: 'test session',
          lifecycle: 'active',
          archivedAt: null,
          permissionMode: null,
          codexSandbox: null,
          claudeCodeSandbox: null,
          genericPtyConfig: null,
          createdAt: 1234,
          lastEventAt: 5678,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    // 自定义 deps：runGit 走真模拟（callerCwd → main repo /Users/test/repo），但 cwd
    // **不**注入（让 handler 走 sessionRepo 反查路径）；files / readFile 模拟正常
    const files = new Map<string, string>();
    files.set(planFilePath, planContent({ planId, status: 'in_progress' }));
    const gitCallsSeen: Array<{ args: string[]; cwd: string }> = [];
    const partialDeps: StartNextSessionDeps = {
      runGit: async (args, cwd) => {
        gitCallsSeen.push({ args, cwd });
        if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
          return '/Users/test/repo/.git';
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      readFile: async (p) => {
        const c = files.get(p);
        if (c === undefined) throw new Error(`ENOENT: ${p}`);
        return c;
      },
      exists: async (p) => files.has(p),
      homedir: () => fakeHomedir,
      // **故意不传 cwd** — 验证 handler 注入路径
    };

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 's', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: StartNextSessionArgs = { plan_id: planId, adapter: 'claude-code' };
    const ctx: HandlerContext = {
      caller: { callerSessionId: callerSid, transport: 'in-process' },
    };

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: partialDeps,
    });

    expect(result.isError).toBeFalsy();
    // 验证：handler 从 sessionRepo 拿到 callerCwd 注入 impl，impl 的 runGit 用此 cwd 反查
    expect(gitCallsSeen).toHaveLength(1);
    expect(gitCallsSeen[0]!.cwd).toBe(callerCwd); // ← 关键：不是 process.cwd()
    expect(sessionRepoGetSpy).toHaveBeenCalledWith(callerSid);

    sessionRepoGetSpy.mockRestore();
  });

  it('caller 显式传 implDeps.cwd → 优先级最高（mergeCallerCwd 不反查 sessionRepo）', async () => {
    const planId = 'caller-explicit-cwd';
    const callerSid = 'should-not-be-queried-for-cwd';
    const explicitCwd = '/Users/test/explicit/cwd';
    const planFilePath = `${explicitCwd}/.claude/plans/${planId}.md`;
    const files = new Map<string, string>();
    files.set(planFilePath, planContent({ planId, status: 'in_progress' }));

    // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 在 archive 路径独立加了
    // sessionRepo.get(callerSid) 探针，与 mergeCallerCwd 反查路径无关。本 case 原
    // intent 是「caller 显式 cwd → mergeCallerCwd 不反查 sessionRepo」，但 F1 加的
    // archive 探针仍会调 sessionRepo.get。改 spy 让 callerSid 有 fake row（让 archive
    // 路径走完）+ 用 gitCalls.cwd === explicitCwd 隐式验证 mergeCallerCwd 走 caller
    // 显式 cwd（不是 sessionRepo 反查的 cwd）。
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === callerSid) {
        return {
          id: callerSid,
          agentId: 'claude-code',
          cwd: '/some/sessionrepo/cwd', // ≠ explicitCwd（用来验证 mergeCallerCwd 没用此值）
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

    const gitCallsSeen: Array<{ args: string[]; cwd: string }> = [];
    const explicitDeps: StartNextSessionDeps = {
      runGit: async (gitArgs, cwd) => {
        gitCallsSeen.push({ args: gitArgs, cwd });
        if (cwd === explicitCwd) return `${explicitCwd}/.git`;
        throw new Error(`unexpected cwd: ${cwd}`);
      },
      readFile: async (p) => files.get(p) ?? Promise.reject(new Error(`ENOENT: ${p}`)),
      exists: async (p) => files.has(p),
      cwd: () => explicitCwd, // ← caller 显式传
      homedir: () => '/Users/test',
    };

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 's', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: StartNextSessionArgs = { plan_id: planId, adapter: 'claude-code' };
    const ctx: HandlerContext = {
      caller: { callerSessionId: callerSid, transport: 'in-process' },
    };

    const result = await startNextSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: explicitDeps,
    });

    expect(result.isError).toBeFalsy();
    // 关键验证：mergeCallerCwd 走 caller 显式 cwd（gitCalls.cwd === explicitCwd），**不是**
    // sessionRepo 反查的 cwd（'/some/sessionrepo/cwd'）。证明 mergeCallerCwd 优先 caller 显式。
    expect(gitCallsSeen).toHaveLength(1);
    expect(gitCallsSeen[0]!.cwd).toBe(explicitCwd);
    sessionRepoGetSpy.mockRestore();
  });
});
