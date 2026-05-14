/**
 * hand_off_session handler deny + happy path 单测（CHANGELOG_105 拆分自 hand-off-session.test.ts）。
 *
 * 范围：handOffSessionHandler
 * - deny external caller（plan-driven 模式拒 external transport）
 * - happy path with mock spawn（K2 metadata 透传 + spawn 字段透传 + 归档 caller）
 *
 * 不真起 git / 不真碰 fs / 不真起 SDK session：deps inject + vi.fn mock spawn handler，
 * vi.spyOn(sessionRepo) 局部 spy（无文件级 vi.mock，所以 setup 可走 _setup.ts 共享）。
 *
 * 其它范围：
 * - impl 五段 → hand-off-session.impl-core.test.ts
 * - handler caller cwd 反查 + generic mode → hand-off-session.handler-cwd-generic.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

describe('handOffSessionHandler — deny external caller', () => {
  it('caller_session_id = __external__ + transport=stdio → 拒绝', async () => {
    const args: HandOffSessionArgs = {
      plan_id: 'whatever',
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: '__external__',
        transport: 'stdio',
      },
    };

    const result = await handOffSessionHandler(args, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
  });
});

describe('handOffSessionHandler — happy path with mock spawn', () => {
  // CHANGELOG_106:noop shutdownTeammates seam,让本 describe 6 case 不撞 DB 未 init
  // (CHANGELOG_97/98 case 范围与 teammate shutdown 无关,但 handler 集成 helper 后默认走
  // 真 helper 会调 agentDeckTeamRepo 撞 DB)
  const noopShutdown = vi.fn(async (_callerSid: string) => ({
    closed: [],
    failed: [],
    skipped: 'caller-not-lead' as const,
  }));
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
    // CHANGELOG_99：mock 返回 cwd 字段 = mainRepo（与 K2 改 default cwd = mainRepo 一致）
    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'fake-sid',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
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

    const args: HandOffSessionArgs = {
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

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
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
    expect(data.cwd).toBe('/Users/test/repo'); // CHANGELOG_99: mainRepo 不是 worktreePath
    expect(data.teamId).toBeNull();
    expect(data.teamName).toBeNull();
    expect(data.spawnPromptMessageId).toBeNull();
    // CHANGELOG_98 / Phase A5 / R2 反馈：archived 三态字段断言（'ok' / 'failed' / 'skipped'）
    expect(data.archived).toBe('ok');

    // spawn 调用参数：cwd 默认 mainRepo（CHANGELOG_99；不再是 worktree_path），
    // **default 不传 team_name**（CHANGELOG_97），prompt 是 cold-start
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    expect(spawnArgs.cwd).toBe('/Users/test/repo'); // CHANGELOG_99: mainRepo 不是 worktreePath
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

    const args: HandOffSessionArgs = {
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

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
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

    const args: HandOffSessionArgs = {
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

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
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

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'ghost-caller-sid', transport: 'in-process' },
    };

    // sessionRepo.get(ghost-caller-sid) → null（caller row 不存在 = F1 探针挡）
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation(() => null);

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
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

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('fan-out limit reached');
    // 不应嵌套包装（如 "hand_off_session error: spawn error: ..."）
    expect(result.content[0]!.text).not.toContain('hand_off_session');
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

    const args: HandOffSessionArgs = {
      plan_id: 'no-such-plan',
      adapter: 'claude-code',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      // CHANGELOG_106:noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('plan file not found');
    expect(mockSpawn).not.toHaveBeenCalled();
    // CHANGELOG_97：plan 解析失败 → 既不 spawn 也不归档（baton 还没出手）
    expect(mockArchive).not.toHaveBeenCalled();
  });
});

// ─── CHANGELOG_106: shutdownTeammatesOnBaton 集成 ────────────────────────
//
// 范围:handOffSessionHandler 调 shutdownTeammates helper 的行为 + ok return.teammatesShutdown 字段。
// deps inject + mock helper,不需要真碰 sessionManager.close / agentDeckTeamRepo。
//
// 与 archive-plan handler 同款 5 case:
// 1. happy path: helper 返回 closed=[A,B] → 透传
// 2. keep_teammates=true: 不调 helper + skipped='keep-teammates'
// 3. caller-not-lead: helper 返回 → 透传(caller 是 teammate 罕见 case)
// 4. helper 抛错: 兜底 skipped=null + closed=[] + warn,archive caller 仍走
// 5. spawn 失败短路: 不调 helper(baton 没成功不该牵连 teammate)
describe('handOffSessionHandler — CHANGELOG_106 shutdownTeammatesOnBaton 集成', () => {
  // helper:让 caller-sid 在 sessionRepo 表里有 row(让 archive caller 走 'ok' 路径)
  async function spyCallerRow() {
    const { sessionRepo } = await import('@main/store/session-repo');
    return vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
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
  }

  function makePlanFixture(planId: string): { state: ReturnType<typeof makeState>; planFilePath: string; worktreePath: string } {
    const state = makeState();
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );
    return { state, planFilePath, worktreePath };
  }

  function makeOkSpawn() {
    return vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'new-sid',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
            }),
          },
        ],
      }),
    );
  }

  it('happy path: helper 返回 closed=[A,B] → ok.teammatesShutdown 透传 + archive caller 仍调用', async () => {
    const { state } = makePlanFixture('happy-helper');
    const mockSpawn = makeOkSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_callerSid: string) => ({
      closed: ['teammate-X', 'teammate-Y'],
      failed: [],
      skipped: null as null,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await handOffSessionHandler(
      { plan_id: 'happy-helper', adapter: 'claude-code' },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.teammatesShutdown).toEqual({
      closed: ['teammate-X', 'teammate-Y'],
      failed: [],
      skipped: null,
    });
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledWith('caller-sid');
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');

    sessionRepoGetSpy.mockRestore();
  });

  it('keep_teammates=true → 不调 helper + skipped=keep-teammates + archive caller 仍调用', async () => {
    const { state } = makePlanFixture('keep-teammates');
    const mockSpawn = makeOkSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: null as null,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await handOffSessionHandler(
      { plan_id: 'keep-teammates', adapter: 'claude-code', keep_teammates: true },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.teammatesShutdown).toEqual({
      closed: [],
      failed: [],
      skipped: 'keep-teammates',
    });
    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');

    sessionRepoGetSpy.mockRestore();
  });

  it('caller-not-lead: helper 返回 caller-not-lead → 透传', async () => {
    const { state } = makePlanFixture('not-lead');
    const mockSpawn = makeOkSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: 'caller-not-lead' as const,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await handOffSessionHandler(
      { plan_id: 'not-lead', adapter: 'claude-code' },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.teammatesShutdown.skipped).toBe('caller-not-lead');
    expect(data.teammatesShutdown.closed).toEqual([]);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockArchive).toHaveBeenCalledTimes(1);

    sessionRepoGetSpy.mockRestore();
  });

  it('helper 自身抛错 → 兜底 skipped=null + closed=[] + warn,archive caller 仍走', async () => {
    const { state } = makePlanFixture('helper-crash');
    const mockSpawn = makeOkSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => {
      throw new Error('simulated helper crash (DB exception / mock failure)');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await handOffSessionHandler(
      { plan_id: 'helper-crash', adapter: 'claude-code' },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.teammatesShutdown).toEqual({
      closed: [],
      failed: [],
      skipped: null,
    });
    // 关键: archive caller 仍走(helper 故障不阻塞 baton 收口)
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shutdownTeammatesOnBaton helper failed for caller caller-sid'),
      expect.any(Error),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('spawn 失败短路 → 不调 helper / 不调 archive(baton 没成功不该牵连 teammate)', async () => {
    const { state } = makePlanFixture('spawn-fail');
    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'fan-out limit reached' }),
          },
        ],
        isError: true as const,
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: null as null,
    }));

    const result = await handOffSessionHandler(
      { plan_id: 'spawn-fail', adapter: 'claude-code' },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBe(true);
    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockArchive).not.toHaveBeenCalled();
  });
});

