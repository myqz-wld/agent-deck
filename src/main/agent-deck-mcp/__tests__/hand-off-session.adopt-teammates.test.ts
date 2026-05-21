/**
 * hand_off_session adopt_teammates 路径集成测试(plan hand-off-session-adopt-teammates-20260520
 * Phase 4 step T4.4-T4.7 + Phase 6 T6.X1-T6.X4)。
 *
 * **范围**:验证 handOffSessionHandler args.adopt_teammates: true 时:
 * - N5 ≥1 lead 硬约束 fail-fast(T4.7):caller 无任何 lead membership → handler return err 不
 *   spawn / 不 archive
 * - N2.b cold-start prompt 装配(T4.4 single-team / T4.5 multi-team):spawn args.prompt 含
 *   buildAdoptedTeamsContextBlock 输出 + 不含 wire prefix / 不含 spawn 路径 lead context block
 * - 不写 placeholder + spawnPromptMessageId 返 null + initialPrompt 与 SDK first message 一致
 *   (T4.6)
 *
 * Phase 4 阶段 phase 1.5 swapLead 还没真跑(Phase 6 才完整化),所以 ok return.adopted 字段:
 * - teamsTotal: caller lead memberships count
 * - teamsAdopted: 0(swapLead 未跑)
 * - preserved: []
 * - failed: []
 * - firstTeamId: callerLeadMemberships[0].teamId(non-null)
 *
 * Phase 6 集成(T6.X1-T6.X4)在 baton-cleanup helper 内调 swapLead 完整化 phase 1.5,
 * 此时 teamsAdopted / preserved / failed 字段会含真实 adopt 结果。
 *
 * **mock 模式**:vi.spyOn 局部 spy(sessionRepo + agentDeckTeamRepo + handler 内调用的全部
 * method),deps inject(spawnSession + archiveSession + shutdownTeammates seam)。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import type { AgentDeckTeam, AgentDeckTeamMember } from '@shared/types';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

// ─── helpers ──────────────────────────────────────────────────────────

/** 构造 caller-sid 的 sessionRepo.get fake row(让 baton-cleanup phase 2 archive 走 'ok' 路径) */
function fakeCallerRow(sid = 'caller-sid') {
  return {
    id: sid,
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
    cwdReleaseMarker: null,
  } as never;
}

/** 构造 fake AgentDeckTeam */
function fakeTeam(id: string, name: string): AgentDeckTeam {
  return {
    id,
    name,
    archivedAt: null,
    archiveReason: null,
    createdAt: 0,
    metadata: {},
  };
}

/** 构造 fake AgentDeckTeamMember(active 默认 leftAt=null) */
function fakeMember(opts: {
  teamId: string;
  sessionId: string;
  role: 'lead' | 'teammate';
  leftAt?: number | null;
}): AgentDeckTeamMember {
  return {
    teamId: opts.teamId,
    sessionId: opts.sessionId,
    role: opts.role,
    displayName: null,
    joinedAt: 1_000,
    leftAt: opts.leftAt ?? null,
  };
}

/** 构造一个返回 ok JSON 的 mock spawnSessionHandler */
function makeOkSpawn(seenSpawnArgs: { ref: SpawnSessionArgs | null }) {
  return vi.fn(
    async (
      spawnArgs: SpawnSessionArgs,
      _ctx: HandlerContext,
    ): Promise<HandlerResult> => {
      seenSpawnArgs.ref = spawnArgs;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'new-sid',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              agentName: null,
              displayName: null,
              spawnDepth: 1,
              sentAt: 1234567890,
              spawnPromptMessageId: null, // adopt 路径 spawn 不传 team_name → spawn 不写 placeholder
            }),
          },
        ],
      };
    },
  );
}

const noopShutdown = vi.fn(async (_callerSid: string) => ({
  closed: [],
  failed: [],
  skipped: 'caller-not-lead' as const,
}));

/**
 * Phase 6 helper: 默认让所有 swapLead 调用返 swapped:true(避免 firstTeam fatal abort
 * 撞 default mock stub `mocked-no-op`)。test 单独 override 让特定 teamId swapLead 失败 /
 * throws。
 */
const okSwapLead = vi.fn(
  (
    _teamId: string,
    _oldSid: string,
    _newSid: string,
    _opts?: { newDisplayName?: string | null },
  ) => ({ swapped: true as const }),
);

/** Phase 6 helper: getSessionForLifecycle default 返 active session(让 lifecycle precheck 通过) */
const activeLifecycleGet = vi.fn((sid: string) => ({
  id: sid,
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
  cwdReleaseMarker: null,
}) as never);

/** Phase 6 helper: listAllMembersForAdopt default 空数组(无 teammate);test 单独 override 加 teammate */
const emptyListMembers = vi.fn((_teamId: string) => []);

/** Phase 6 helper: closeSession default no-op */
const noopCloseSession = vi.fn(async (_sid: string) => undefined);

/**
 * Phase 6 helper: 复用 Phase 4 测试 default deps(spawn 之后跑 phase 1.5 swapLead loop +
 * lifecycle precheck + emit + collect)— 让 firstTeam swap 默认成功通过 fatal abort 短路。
 */
function defaultPhase6Deps() {
  return {
    swapLead: okSwapLead,
    getSessionForLifecycle: activeLifecycleGet,
    listAllMembersForAdopt: emptyListMembers,
    closeSession: noopCloseSession,
  } as const;
}

const noopArchive = vi.fn(async (_sid: string) => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handOffSessionHandler — adopt_teammates: true (Phase 4)', () => {
  it('T4.7: N5 ≥1 lead 硬约束 fail-fast — caller 无任何 lead membership → return err 不 spawn / 不 archive', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/no-lead.md',
      planContent({
        planId: 'no-lead',
        worktreePath: '/Users/test/repo/.claude/worktrees/no-lead',
        status: 'in_progress',
      }),
    );

    // caller 在 0 个 active team 是 lead(空 membership 或全 teammate 都触发 N5 fail-fast)
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([]);

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);
    const archiveCalls: string[] = [];
    const mockArchive = vi.fn(async (sid: string) => {
      archiveCalls.push(sid);
    });

    const args: HandOffSessionArgs = {
      plan_id: 'no-lead',
      adapter: 'claude-code',
      adopt_teammates: true,
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
      ...defaultPhase6Deps(),
    });

    expect(result.isError).toBe(true);
    const errBody = JSON.parse(result.content[0]!.text);
    expect(errBody.error).toMatch(/adopt_teammates 要求 caller 至少在一个 active team 是 lead/);

    // **关键守门**:spawn 未调用 + archive 未调用
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(archiveCalls).toEqual([]);
  });

  it('T4.7: N5 fail-fast — caller 仅 teammate role(无 lead role) → fail-fast', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/teammate-only.md',
      planContent({
        planId: 'teammate-only',
        worktreePath: '/Users/test/repo/.claude/worktrees/teammate-only',
        status: 'in_progress',
      }),
    );

    // caller 在 2 个 team 都是 teammate(无 lead)→ fail-fast
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'teammate' }),
      fakeMember({ teamId: 'team-B', sessionId: 'caller-sid', role: 'teammate' }),
    ]);
    // Phase 7 reviewer-codex Round 3 polish:caller=teammate 现在也查 team archived,
    // T4.7 加 spy 让 active fakeTeam 让 snapshot loop 不撞 spy-less DB error;
    // active team + caller 全 teammate → callerLeadMemberships=0 → 仍走 fail-fast。
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) =>
      fakeTeam(teamId, `${teamId}-name`),
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);
    const result = await handOffSessionHandler(
      {
        plan_id: 'teammate-only',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toMatch(/adopt_teammates 要求 caller/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('T4.4 N2.b 守门 (single-team): cold-start prompt 含 adopted teams context block + 不含 wire prefix', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/single-team.md',
      planContent({
        planId: 'single-team',
        worktreePath: '/Users/test/repo/.claude/worktrees/single-team',
        status: 'in_progress',
      }),
    );

    // caller 在 1 个 team 是 lead,team 内有 2 个 teammate
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-primary', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) => {
      if (teamId === 'team-primary') return fakeTeam('team-primary', 'review-team');
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      if (teamId === 'team-primary') {
        return [
          fakeMember({ teamId: 'team-primary', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-primary', sessionId: 'reviewer-A', role: 'teammate' }),
          fakeMember({ teamId: 'team-primary', sessionId: 'reviewer-B', role: 'teammate' }),
        ];
      }
      return [];
    });
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);

    const result = await handOffSessionHandler(
      {
        plan_id: 'single-team',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );

    expect(result.isError).toBeFalsy();
    expect(seenSpawn.ref).not.toBeNull();
    const promptForSpawn = seenSpawn.ref!.prompt;

    // **核心**:含 adopted teams context block(buildAdoptedTeamsContextBlock 输出)
    expect(promptForSpawn).toContain("## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)");
    expect(promptForSpawn).toContain('### Primary team — `review-team` (id: `team-primary`)');
    expect(promptForSpawn).toContain('Teammate sids: `reviewer-A`, `reviewer-B`');
    expect(promptForSpawn).toContain('### How to communicate with teammates');

    // **不含**:wire prefix(`[from ...][msg ...][sid ...]`)
    expect(promptForSpawn).not.toMatch(/^\[from /);
    // **不含**:spawn 路径 lead context block(`## Hand-off context`)
    expect(promptForSpawn).not.toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
    // **不含**:"回 lead" 指令
    expect(promptForSpawn).not.toContain('回 lead 用');
    // **不含**:Round 7 codex MED-1 修法守门 — 不含 newSid placeholder 字串
    expect(promptForSpawn).not.toContain('__ADOPT_NEW_LEAD_SID__');

    // **不含 multi-team 节**(单 team caller)
    expect(promptForSpawn).not.toContain('**attempted** to adopt as lead');

    // **adopt 路径不传 team_name 给 spawn**(N2.c 互斥 + adopt 路径强制 default baton)
    expect(seenSpawn.ref!.team_name).toBeUndefined();
  });

  it('T4.5 N2.b 守门 (multi-team N=2): primary + multi-team 节 + attempted warning', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/multi-team.md',
      planContent({
        planId: 'multi-team',
        worktreePath: '/Users/test/repo/.claude/worktrees/multi-team',
        status: 'in_progress',
      }),
    );

    // caller 在 2 个 team 都是 lead
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-2', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) => {
      if (teamId === 'team-1') return fakeTeam('team-1', 'team-one');
      if (teamId === 'team-2') return fakeTeam('team-2', 'team-two');
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      if (teamId === 'team-1') {
        return [
          fakeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-1', sessionId: 'tm-1A', role: 'teammate' }),
        ];
      }
      if (teamId === 'team-2') {
        return [
          fakeMember({ teamId: 'team-2', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-2', sessionId: 'tm-2A', role: 'teammate' }),
          fakeMember({ teamId: 'team-2', sessionId: 'tm-2B', role: 'teammate' }),
        ];
      }
      return [];
    });
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);

    const result = await handOffSessionHandler(
      {
        plan_id: 'multi-team',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );

    expect(result.isError).toBeFalsy();
    const promptForSpawn = seenSpawn.ref!.prompt;

    // **Primary team 节**(team-1 是 callerLeadMemberships[0])
    expect(promptForSpawn).toContain('### Primary team — `team-one` (id: `team-1`)');
    expect(promptForSpawn).toContain('Teammate sids: `tm-1A`');

    // **Multi-team 节** + Round 7 codex LOW 修法 "attempted" 标记 + verify warning
    expect(promptForSpawn).toContain('### Multi-team — other teams **attempted** to adopt as lead');
    expect(promptForSpawn).toContain('verify shared team membership via `list_sessions`');
    expect(promptForSpawn).toContain('- Team `team-two` (id: `team-2`): teammate sids `tm-2A`, `tm-2B`');

    // 总 team 数 N=2
    expect(promptForSpawn).toContain('You (the new SDK session) just became lead of 2 teams');

    // 仍**不含** wire prefix / spawn-style "回 lead" 指令
    expect(promptForSpawn).not.toMatch(/^\[from /);
    expect(promptForSpawn).not.toContain('回 lead 用');
  });

  it('T4.6: adopt 路径 spawnPromptMessageId 返 null + initialPrompt 与 spawn args.prompt 一致', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/test-prompt.md',
      planContent({
        planId: 'test-prompt',
        worktreePath: '/Users/test/repo/.claude/worktrees/test-prompt',
        status: 'in_progress',
      }),
    );

    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-X', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockReturnValue(fakeTeam('team-X', 'team-name-X'));
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockReturnValue([
      fakeMember({ teamId: 'team-X', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);

    const result = await handOffSessionHandler(
      {
        plan_id: 'test-prompt',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **adopt 路径 spawnPromptMessageId 恒返 null**(adopt 不写 placeholder — Round 6 MED-1 修法)
    // mock spawn 也返 null,handler 强制 null:`args.adopt_teammates ? null : spawnData.spawnPromptMessageId`
    expect(data.spawnPromptMessageId).toBeNull();

    // **initialPrompt 与 SDK first message(spawn args.prompt)一致** — schemas.ts 「完整字面」契约
    expect(data.initialPrompt).toBe(seenSpawn.ref!.prompt);

    // adopt 路径下 adopted 字段 non-null
    expect(data.adopted).not.toBeNull();
    expect(data.adopted.firstTeamId).toBe('team-X');
    expect(data.adopted.teamsTotal).toBe(1);
    // Phase 6 完成: swapLead default 返 swapped:true → teamsAdopted=1 + preserved=[]
    // (default emptyListMembers seam 让 team 内无 teammate)
    expect(data.adopted.teamsAdopted).toBe(1);
    expect(data.adopted.preserved).toEqual([]);
    expect(data.adopted.failed).toEqual([]);

    // **default baton 路径** ok return.adopted === null(回归保护)
    // 用同款 fixture 不传 adopt_teammates 跑一次确认
    seenSpawn.ref = null;
    const defaultResult = await handOffSessionHandler(
      {
        plan_id: 'test-prompt',
        adapter: 'claude-code',
        // 不传 adopt_teammates
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );
    expect(defaultResult.isError).toBeFalsy();
    const defaultData = JSON.parse(defaultResult.content[0]!.text);
    expect(defaultData.adopted).toBeNull();
  });

  it('T4 baton-cleanup 集成: adopt_teammates: true → teammatesShutdown.skipped="adopt-keep-implicit" + shutdown helper 不调用', async () => {
    const state = makeState();
    state.files.set(
      '/Users/test/repo/.claude/plans/integration.md',
      planContent({
        planId: 'integration',
        worktreePath: '/Users/test/repo/.claude/worktrees/integration',
        status: 'in_progress',
      }),
    );

    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-Y', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockReturnValue(fakeTeam('team-Y', 'team-Y-name'));
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockReturnValue([
      fakeMember({ teamId: 'team-Y', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-Y', sessionId: 'reviewer-X', role: 'teammate' }),
    ]);
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSpawn = makeOkSpawn(seenSpawn);
    const mockShutdown = vi.fn(async (_callerSid: string) => ({
      closed: ['reviewer-X'],
      failed: [],
      skipped: null as null,
    }));

    const result = await handOffSessionHandler(
      {
        plan_id: 'integration',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: mockSpawn,
        archiveSession: noopArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
        ...defaultPhase6Deps(),
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **adopt 路径 baton-cleanup phase 1 标 skipped='adopt-keep-implicit'** + shutdown helper 不调用
    expect(data.teammatesShutdown).toEqual({
      closed: [],
      failed: [],
      skipped: 'adopt-keep-implicit',
    });
    expect(mockShutdown).not.toHaveBeenCalled();
    // archive caller 仍走(adopt 路径不影响 phase 2 archive)
    expect(data.archived).toBe('ok');
  });
});

// ─── plan hand-off-session-adopt-teammates-20260520 Phase 6 集成测试 ─────
//
// **范围**:phase 1.5 完整流程(handler 内 swapLead loop + listAllMembers + lifecycle precheck +
// emit + collect)— 走 T6.1 happy / T6.2 closed teammate / T6.3 session-missing / T6.4 multi-team
// teammate sid 去重 / T6.X1 caller-not-lead-in-team / T6.X2 非 firstTeam 软失败 / T6.X3a/b
// firstTeam fatal abort 双路径(swapped:false + throws)/ T6.X4 partial adopt 接受。
//
// fixture 同 Phase 4 集成测试(makeOkSpawn + agentDeckTeamRepo / sessionRepo spy)。
describe('handOffSessionHandler — adopt_teammates 路径 phase 1.5 集成 (Phase 6)', () => {
  // helper:加 caller 在指定 team 是 lead + caller 自己 row 的 sessionRepo + agentDeckTeamRepo spy
  function setupCallerLead(
    leadTeamIds: string[],
    teammates: Map<string, AgentDeckTeamMember[]>,
  ) {
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue(
      leadTeamIds.map((id) =>
        fakeMember({ teamId: id, sessionId: 'caller-sid', role: 'lead' }),
      ),
    );
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) =>
      leadTeamIds.includes(teamId) ? fakeTeam(teamId, `${teamId}-name`) : null,
    );
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      const tms = teammates.get(teamId) ?? [];
      return [fakeMember({ teamId, sessionId: 'caller-sid', role: 'lead' }), ...tms];
    });
  }

  function setupPlanFile(state: ReturnType<typeof makeState>, planId: string) {
    state.files.set(
      `/Users/test/repo/.claude/plans/${planId}.md`,
      planContent({
        planId,
        worktreePath: `/Users/test/repo/.claude/worktrees/${planId}`,
        status: 'in_progress',
      }),
    );
  }

  it('T6.1 happy 路径: single-team caller + 2 active teammate → swapLead 成功 + preserved=2 + emit × 4 + N8 守门', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-1-happy');
    setupCallerLead(
      ['team-A'],
      new Map([
        [
          'team-A',
          [
            fakeMember({ teamId: 'team-A', sessionId: 'tm-1', role: 'teammate' }),
            fakeMember({ teamId: 'team-A', sessionId: 'tm-2', role: 'teammate' }),
          ],
        ],
      ]),
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    // Phase 7 reviewer-codex INFO 修法:N8 emit 守门 — spy eventBus.emit + sessionManager
    // .notifyTeamMembershipChanged 让删 handler 内 emit/notify 行为时本测试立即失败。
    // 修前 T6.1 测试名「emit × 4 + N8 守门」与实际无 spy 断言矛盾(grep 0 处),让 N8 的 4 处
    // emit/notify 漏测。
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => undefined);
    const notifySpy = vi
      .spyOn(sessionManager, 'notifyTeamMembershipChanged')
      .mockImplementation(() => undefined);

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));
    const mockListMembers = vi.fn((teamId: string) =>
      teamId === 'team-A'
        ? [
            fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
            fakeMember({ teamId: 'team-A', sessionId: 'tm-1', role: 'teammate' }),
            fakeMember({ teamId: 'team-A', sessionId: 'tm-2', role: 'teammate' }),
          ]
        : [],
    );

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-1-happy',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: mockListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **swapLead 调用守门**:firstTeam = team-A 调一次
    expect(mockSwapLead).toHaveBeenCalledTimes(1);
    expect(mockSwapLead).toHaveBeenCalledWith('team-A', 'caller-sid', 'new-sid');

    // **adopted 详情**:teamsTotal=1 + teamsAdopted=1 + preserved=[tm-1, tm-2] + failed=[]
    expect(data.adopted.teamsTotal).toBe(1);
    expect(data.adopted.teamsAdopted).toBe(1);
    expect(data.adopted.preserved.sort()).toEqual(['tm-1', 'tm-2']);
    expect(data.adopted.failed).toEqual([]);
    expect(data.adopted.firstTeamId).toBe('team-A');

    // **N8 emit 守门**(Phase 7 reviewer-codex INFO 修法):每成功 swap team(team-A)
    // 触发 2 次 eventBus.emit('agent-deck-team-member-changed', ...) + 2 次
    // sessionManager.notifyTeamMembershipChanged(...)。teamsAdopted=1 → 共 2 emit + 2 notify。
    const memberEmits = emitSpy.mock.calls.filter(
      (call) => call[0] === 'agent-deck-team-member-changed',
    );
    expect(memberEmits.length).toBe(2);
    expect(memberEmits[0]?.[1]).toMatchObject({
      teamId: 'team-A',
      sessionId: 'caller-sid',
      kind: 'left',
    });
    expect(memberEmits[1]?.[1]).toMatchObject({
      teamId: 'team-A',
      sessionId: 'new-sid',
      kind: 'joined',
    });
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(notifySpy).toHaveBeenNthCalledWith(1, 'caller-sid');
    expect(notifySpy).toHaveBeenNthCalledWith(2, 'new-sid');
  });

  it('T6.2 closed teammate → failed.reason="lifecycle-closed"', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-2-closed');
    setupCallerLead(
      ['team-B'],
      new Map([
        [
          'team-B',
          [
            fakeMember({ teamId: 'team-B', sessionId: 'tm-active', role: 'teammate' }),
            fakeMember({ teamId: 'team-B', sessionId: 'tm-closed', role: 'teammate' }),
          ],
        ],
      ]),
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));
    const mockListMembers = vi.fn(() => [
      fakeMember({ teamId: 'team-B', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-B', sessionId: 'tm-active', role: 'teammate' }),
      fakeMember({ teamId: 'team-B', sessionId: 'tm-closed', role: 'teammate' }),
    ]);
    const mockGetLifecycle = vi.fn((sid: string) => {
      if (sid === 'tm-closed') {
        return { ...(fakeCallerRow(sid) as object), lifecycle: 'closed' } as never;
      }
      if (sid === 'tm-active') {
        return { ...(fakeCallerRow(sid) as object), lifecycle: 'active' } as never;
      }
      return null;
    });

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-2-closed',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: mockGetLifecycle,
        listAllMembersForAdopt: mockListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(data.adopted.preserved).toEqual(['tm-active']);
    expect(data.adopted.failed).toEqual([
      { sid: 'tm-closed', reason: 'lifecycle-closed', teamId: 'team-B' },
    ]);
  });

  it('T6.3 session-missing → failed.reason="session-missing"', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-3-missing');
    setupCallerLead(
      ['team-C'],
      new Map([
        [
          'team-C',
          [fakeMember({ teamId: 'team-C', sessionId: 'tm-ghost', role: 'teammate' })],
        ],
      ]),
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));
    const mockListMembers = vi.fn(() => [
      fakeMember({ teamId: 'team-C', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-C', sessionId: 'tm-ghost', role: 'teammate' }),
    ]);
    const mockGetLifecycle = vi.fn(() => null); // ghost teammate → session-missing

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-3-missing',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: mockGetLifecycle,
        listAllMembersForAdopt: mockListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(data.adopted.preserved).toEqual([]);
    expect(data.adopted.failed).toEqual([
      { sid: 'tm-ghost', reason: 'session-missing', teamId: 'team-C' },
    ]);
  });

  it('T6.4 multi-team caller(N=2 都 lead): teamsTotal=2 teamsAdopted=2 + preserved 跨 team sid 去重', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-4-multi');
    // caller 在 team-1 + team-2 都是 lead;tm-shared 同时在两个 team(跨 team 共享 sid 去重测试)
    setupCallerLead(
      ['team-1', 'team-2'],
      new Map([
        [
          'team-1',
          [
            fakeMember({ teamId: 'team-1', sessionId: 'tm-only-1', role: 'teammate' }),
            fakeMember({ teamId: 'team-1', sessionId: 'tm-shared', role: 'teammate' }),
          ],
        ],
        [
          'team-2',
          [
            fakeMember({ teamId: 'team-2', sessionId: 'tm-shared', role: 'teammate' }),
            fakeMember({ teamId: 'team-2', sessionId: 'tm-only-2', role: 'teammate' }),
          ],
        ],
      ]),
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));
    const mockListMembers = vi.fn((teamId: string) => {
      if (teamId === 'team-1') {
        return [
          fakeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-1', sessionId: 'tm-only-1', role: 'teammate' }),
          fakeMember({ teamId: 'team-1', sessionId: 'tm-shared', role: 'teammate' }),
        ];
      }
      if (teamId === 'team-2') {
        return [
          fakeMember({ teamId: 'team-2', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-2', sessionId: 'tm-shared', role: 'teammate' }),
          fakeMember({ teamId: 'team-2', sessionId: 'tm-only-2', role: 'teammate' }),
        ];
      }
      return [];
    });

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-4-multi',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: mockListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(mockSwapLead).toHaveBeenCalledTimes(2); // firstTeam + 非 firstTeam
    expect(data.adopted.teamsTotal).toBe(2);
    expect(data.adopted.teamsAdopted).toBe(2);

    // **跨 team 共享 sid 去重**(Round 3 LOW Set 修法):tm-shared 同时在 team-1+team-2,preserved 仅 1 次
    expect(data.adopted.preserved.sort()).toEqual(['tm-only-1', 'tm-only-2', 'tm-shared']);
    expect(data.adopted.preserved.length).toBe(3); // 不是 4(tm-shared 没重复)
    expect(data.adopted.failed).toEqual([]);
  });

  it('T6.X1 caller-not-lead-in-team: caller 在 team-L 是 lead + team-T 是 teammate → team-T 进 failed', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-x1-mixed');
    // caller 在 team-L 是 lead + team-T 是 teammate
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-L', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-T', sessionId: 'caller-sid', role: 'teammate' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) =>
      ['team-L', 'team-T'].includes(teamId) ? fakeTeam(teamId, `${teamId}-name`) : null,
    );
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) =>
      teamId === 'team-L'
        ? [fakeMember({ teamId: 'team-L', sessionId: 'caller-sid', role: 'lead' })]
        : [],
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-x1-mixed',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: emptyListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // swapLead 仅 firstTeam(team-L)调一次,team-T(teammate)不调
    expect(mockSwapLead).toHaveBeenCalledTimes(1);
    expect(mockSwapLead).toHaveBeenCalledWith('team-L', 'caller-sid', 'new-sid');

    // teamsTotal=2(包含 lead + teammate)+ teamsAdopted=1(仅 firstTeam swap 成功)
    expect(data.adopted.teamsTotal).toBe(2);
    expect(data.adopted.teamsAdopted).toBe(1);
    expect(data.adopted.firstTeamId).toBe('team-L');

    // team-T 进 failed.reason='caller-not-lead-in-team'
    expect(data.adopted.failed).toEqual([
      { sid: 'caller-sid', reason: 'caller-not-lead-in-team', teamId: 'team-T' },
    ]);
  });

  it('T6.X2 非 firstTeam swapLead swapped:false 软失败 → 该 team 进 failed,firstTeam 仍成功 + 其他 team 不受影响', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-x2-partial');
    setupCallerLead(['team-1', 'team-2'], new Map());
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    // firstTeam(team-1)成功 + team-2 swapLead swapped:false
    const mockSwapLead = vi.fn((teamId: string) =>
      teamId === 'team-2'
        ? ({ swapped: false as const, reason: 'caller-not-in-team' })
        : ({ swapped: true as const }),
    );

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-x2-partial',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: emptyListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(data.adopted.teamsAdopted).toBe(1); // 仅 firstTeam
    expect(data.adopted.failed).toEqual([
      {
        sid: 'caller-sid',
        teamId: 'team-2',
        reason: 'swap-lead-failed: caller-not-in-team',
      },
    ]);
    // archive caller 仍走(partial adopt 接受)
    expect(data.archived).toBe('ok');
  });

  it('T6.X3a firstTeam swapLead swapped:false → fatal abort + close newSid + 不 archive caller + return error', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-x3a-fatal');
    setupCallerLead(['team-1', 'team-2'], new Map());
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    // firstTeam(team-1)swapped:false → fatal abort
    const mockSwapLead = vi.fn(() => ({ swapped: false as const, reason: 'caller-not-lead' }));
    const mockCloseSession = vi.fn(async (_sid: string) => undefined);
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: 'caller-not-lead' as const,
    }));

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-x3a-fatal',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: mockArchive,
        shutdownTeammates: mockShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: emptyListMembers,
        closeSession: mockCloseSession,
      },
    );

    expect(result.isError).toBe(true);
    const errBody = JSON.parse(result.content[0]!.text);
    expect(errBody.error).toMatch(/adopt firstTeam swap failed/);
    expect(errBody.error).toMatch(/caller-not-lead/);

    // **关键 fatal abort 守门**:firstTeam 一次 swap 失败 → 不继续其他 team(swap 仅调一次)
    expect(mockSwapLead).toHaveBeenCalledTimes(1);
    // **shutdown newSid 一次**(避免交出 stale firstTeam anchor 的孤儿新 session)
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(mockCloseSession).toHaveBeenCalledWith('new-sid');
    // **不 archive caller**(caller 状态零变化 — phase 1.5 fatal abort 早于 runBatonCleanup)
    expect(mockArchive).not.toHaveBeenCalled();
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('T6.X3b firstTeam swapLead throws → fatal abort 同款路径(implementer 必须 try/catch 围 swapLead)', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-x3b-throws');
    setupCallerLead(['team-1', 'team-2'], new Map());
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    // firstTeam swapLead throws(模拟 FK violation / DB error)
    const mockSwapLead = vi.fn(() => {
      throw new Error('simulated FK constraint violation');
    });
    const mockCloseSession = vi.fn(async (_sid: string) => undefined);
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-x3b-throws',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: mockArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: emptyListMembers,
        closeSession: mockCloseSession,
      },
    );

    expect(result.isError).toBe(true);
    const errBody = JSON.parse(result.content[0]!.text);
    expect(errBody.error).toMatch(/adopt firstTeam swap failed/);
    // throws 路径 reason 含 swap-lead-error: <e.message>
    expect(errBody.error).toMatch(/swap-lead-error/);
    expect(errBody.error).toMatch(/simulated FK constraint violation/);

    expect(mockSwapLead).toHaveBeenCalledTimes(1);
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it('T6.X4 partial adopt 接受: firstTeam 成功 + 非 firstTeam 失败 → ok return + caller archive', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-x4-partial-ok');
    setupCallerLead(['team-1', 'team-2'], new Map());
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    // firstTeam(team-1)成功 + team-2 throws
    const mockSwapLead = vi.fn((teamId: string) => {
      if (teamId === 'team-2') {
        throw new Error('simulated team-2 DB error');
      }
      return { swapped: true as const };
    });
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-x4-partial-ok',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: mockArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: emptyListMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(data.adopted.firstTeamId).toBe('team-1');
    expect(data.adopted.teamsAdopted).toBe(1);
    expect(data.adopted.teamsTotal).toBe(2);
    expect(data.adopted.failed).toEqual([
      {
        sid: 'caller-sid',
        teamId: 'team-2',
        reason: 'swap-lead-error: simulated team-2 DB error',
      },
    ]);

    // **partial adopt 接受**:caller archive 仍走(default baton)
    expect(data.archived).toBe('ok');
    expect(mockArchive).toHaveBeenCalledTimes(1);

    // **prompt 含 multi-team 节 attempted warning**(buildAdoptedTeamsContextBlock multi-team 节 — 警告
    // partial adopt 可能失败,新 session 须 list_sessions 验证 shared membership)
    expect(seenSpawn.ref!.prompt).toMatch(/\*\*attempted\*\* to adopt as lead/);
    expect(seenSpawn.ref!.prompt).toMatch(/verify shared team membership via `list_sessions`/);
  });

  // ─── Phase 7 reviewer-codex finding 修法守门 ───────────────────────────

  // T4.3d handler 入口 N2.c 防御性硬约束(Phase 7 reviewer-codex HIGH 修法 — 第二道闸门):
  // 模拟「假设 schema strict refine 被绕过」场景(实际生产 mcp tool 注册路径走 SHAPE 不跑
  // ARGS_SCHEMA refine,需 handler 入口防御作 defense in depth)。直接调 handler 同传 args →
  // 立即 reject + spawnFn 未调用 + caller 状态零变化。
  it('T4.3d handler 入口 N2.c 防御:adopt_teammates=true + team_name 同传立即 reject(spawn 未调用)', async () => {
    const state = makeState();
    setupPlanFile(state, 't4-3d-defense');

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const spawnFn = makeOkSpawn(seenSpawn);
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const result = await handOffSessionHandler(
      // cast 模拟绕过 zod schema 直接调 handler(测 handler defense-in-depth)
      {
        plan_id: 't4-3d-defense',
        adapter: 'claude-code',
        adopt_teammates: true,
        team_name: 'extra-team',
      } as unknown as HandOffSessionArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: spawnFn,
        archiveSession: mockArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
      },
    );

    // **handler reject**:isError + 错误信息含 'adopt_teammates 与 team_name 不可同传'
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.error).toMatch(/adopt_teammates 与 team_name 不可同传/);

    // **副作用零变化**:spawn 未调用 + caller 未 archive
    expect(spawnFn).toHaveBeenCalledTimes(0);
    expect(mockArchive).toHaveBeenCalledTimes(0);
  });

  // T6.A1(MED archived team filter): caller 在 1 active team + 1 archived team 都是 lead →
  // callerLeadMemberships 应过滤掉 archived team(team.archivedAt !== null);仅 active team 进
  // adopt 流程。修前 findActiveMembershipsBySession 只过滤 left_at IS NULL 不过滤 archived_at,
  // archived team 的 ghost lead membership 列入 cold-start prompt → 新 session 调 send_message
  // 撞 no-shared-team(silent dual-team-broken bug)。
  it('T6.A1 archived team filter: caller 在 1 active + 1 archived team 都是 lead → 仅 active team 走 adopt', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-a1-archived-team');

    // active team-A + archived team-A2 都是 lead
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-A2', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') return fakeTeam('team-A', 'team-A-name');
      if (teamId === 'team-A2') {
        // archived team
        return { ...fakeTeam('team-A2', 'team-A2-name'), archivedAt: 1234 };
      }
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') {
        return [
          fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
          fakeMember({ teamId: 'team-A', sessionId: 'tm-1', role: 'teammate' }),
        ];
      }
      return [];
    });
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-a1-archived-team',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: agentDeckTeamRepo.listAllMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **archived team-A2 已被 filter 掉**:firstTeamId=team-A(active)+ teamsAdopted=1
    expect(data.adopted.firstTeamId).toBe('team-A');
    expect(data.adopted.teamsAdopted).toBe(1);

    // **swapLead 仅 1 调用**(active team-A,跳 archived team-A2)
    expect(mockSwapLead).toHaveBeenCalledTimes(1);
    expect(mockSwapLead).toHaveBeenCalledWith('team-A', 'caller-sid', 'new-sid');

    // **cold-start prompt 不含 archived team-A2**(silent prompt 数据丢失防止)
    expect(seenSpawn.ref!.prompt).not.toMatch(/team-A2/);

    // **Phase 7 reviewer-codex Round 2 LOW 修法守门**:
    // teamsTotal=1(activeMemberships 排除 archived team-A2 ghost)+ archived team-A2
    // push failed reason='team-archived' → caller 通过 ok return 看到为啥 team-A2 没 adopt。
    expect(data.adopted.teamsTotal).toBe(1);
    expect(data.adopted.failed).toContainEqual({
      sid: 'caller-sid',
      teamId: 'team-A2',
      reason: 'team-archived',
    });
  });

  // T6.A2(MED archived teammate filter): teammate 中 archivedAt !== null → 进 failed
  // reason='session-archived',与 'lifecycle-closed' 平行。修前 lifecycle precheck 仅查
  // session === null / lifecycle === 'closed',archived teammate 被列入 preserved →
  // 新 session 调 send_message 撞 findSharedActiveTeams 强制 sb.archived_at IS NULL → 拒。
  it('T6.A2 archived teammate filter: archived teammate 进 failed.reason="session-archived"', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-a2-archived-tm');
    setupCallerLead(
      ['team-X'],
      new Map([
        [
          'team-X',
          [
            fakeMember({ teamId: 'team-X', sessionId: 'tm-active', role: 'teammate' }),
            fakeMember({ teamId: 'team-X', sessionId: 'tm-archived', role: 'teammate' }),
          ],
        ],
      ]),
    );
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const archivedLifecycleGet = vi.fn((sid: string) => {
      if (sid === 'tm-active') {
        return {
          id: sid,
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
          cwdReleaseMarker: null,
        } as never;
      }
      if (sid === 'tm-archived') {
        return {
          id: sid,
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active', // 还 active 但 archivedAt 非 null(归档与 lifecycle 正交)
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: 9999, // archived
          spawnedBy: null,
          spawnDepth: 0,
          cwdReleaseMarker: null,
        } as never;
      }
      return null;
    });

    const seenSpawn = { ref: null as SpawnSessionArgs | null };

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-a2-archived-tm',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: okSwapLead,
        getSessionForLifecycle: archivedLifecycleGet,
        listAllMembersForAdopt: agentDeckTeamRepo.listAllMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **active teammate 进 preserved**;archived teammate 进 failed.reason='session-archived'
    expect(data.adopted.preserved).toEqual(['tm-active']);
    expect(data.adopted.failed).toEqual([
      { sid: 'tm-archived', teamId: 'team-X', reason: 'session-archived' },
    ]);

    // **Phase 7 reviewer-codex Round 2 MED 修法守门**:cold-start prompt 装配时已过滤
    // archived teammate(sessionRepo precheck),prompt 不含 tm-archived sid 字符串 →
    // 新 session 不会按 prompt 发 send_message 给已归档 teammate 撞 no-shared-team。
    expect(seenSpawn.ref!.prompt).not.toContain('tm-archived');
    // active teammate 仍出现在 prompt(eligibility precheck 通过)
    expect(seenSpawn.ref!.prompt).toContain('tm-active');
  });

  // T6.A3(Phase 7 reviewer-codex Round 3 LOW polish): caller=teammate 在 archived team
  // 也走 archived 分支 → push failed reason='team-archived'(与 caller=lead 在 archived
  // team 一致)。修前 commit 4ca89e5 caller=teammate 不查 team archived,在 archived team
  // push reason='caller-not-lead-in-team' 与 schemas.ts/文档「teamsTotal 排除 archived
  // ghost」语义略不一致;polish 后所有 caller role 在 archived team 都 reason='team-archived'。
  it('T6.A3 archived team caller=teammate filter: caller=teammate 在 archived team → failed reason="team-archived"(不是 caller-not-lead-in-team)', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-a3-mixed');

    // caller 在 active team-A 是 lead + caller 在 archived team-A2 是 teammate
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-A2', sessionId: 'caller-sid', role: 'teammate' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') return fakeTeam('team-A', 'team-A-name');
      if (teamId === 'team-A2') {
        return { ...fakeTeam('team-A2', 'team-A2-name'), archivedAt: 9999 };
      }
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') {
        return [fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' })];
      }
      return [];
    });
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-a3-mixed',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: agentDeckTeamRepo.listAllMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **caller=lead 在 active team-A → adopt 成功**(firstTeamId=team-A / teamsAdopted=1)
    expect(data.adopted.firstTeamId).toBe('team-A');
    expect(data.adopted.teamsAdopted).toBe(1);

    // **teamsTotal=1**(active eligibility = lead 1 + teammate 0,archived team-A2 排除)
    expect(data.adopted.teamsTotal).toBe(1);

    // **caller=teammate 在 archived team-A2 → failed reason='team-archived'**
    // (Round 3 polish:不再用 'caller-not-lead-in-team',而是与 caller=lead in archived
    // 一致 reason='team-archived')
    expect(data.adopted.failed).toContainEqual({
      sid: 'caller-sid',
      teamId: 'team-A2',
      reason: 'team-archived',
    });
    // **不再含 caller-not-lead-in-team 入口**(commit 4ca89e5 之前 caller=teammate 在
    // archived team 的旧 reason)
    expect(data.adopted.failed).not.toContainEqual({
      sid: 'caller-sid',
      teamId: 'team-A2',
      reason: 'caller-not-lead-in-team',
    });
  });

  // T6.A4(follow-up INFO-7): team row missing(`agentDeckTeamRepo.get` 返 null,DB 不一致
  // 罕见 corner case — FK 约束 ON DELETE 应拦,defense in depth)→ push failed reason=
  // 'team-not-found' 与 'team-archived' 区分;让 caller 通过 ok return 看到精确原因。
  it('T6.A4 team row missing filter: caller=lead 在 active team-A + caller=lead 在 missing team-MISSING → failed reason="team-not-found"', async () => {
    const state = makeState();
    setupPlanFile(state, 't6-a4-missing');

    // caller 在 active team-A 是 lead + caller 在 team-MISSING 是 lead(但 team row 不存在)
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-MISSING', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') return fakeTeam('team-A', 'team-A-name');
      // team-MISSING 返 null 模拟 DB 不一致(FK ON DELETE 应拦但 defense in depth)
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockImplementation((teamId: string) => {
      if (teamId === 'team-A') {
        return [fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' })];
      }
      return [];
    });
    vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) =>
      id === 'caller-sid' ? fakeCallerRow() : null,
    );

    const seenSpawn = { ref: null as SpawnSessionArgs | null };
    const mockSwapLead = vi.fn(() => ({ swapped: true as const }));

    const result = await handOffSessionHandler(
      {
        plan_id: 't6-a4-missing',
        adapter: 'claude-code',
        adopt_teammates: true,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      {
        spawnSession: makeOkSpawn(seenSpawn),
        archiveSession: noopArchive,
        shutdownTeammates: noopShutdown,
        implDeps: makeDeps(state),
        swapLead: mockSwapLead,
        getSessionForLifecycle: activeLifecycleGet,
        listAllMembersForAdopt: agentDeckTeamRepo.listAllMembers,
        closeSession: noopCloseSession,
      },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    // **active team-A adopt 成功**
    expect(data.adopted.firstTeamId).toBe('team-A');
    expect(data.adopted.teamsAdopted).toBe(1);
    // **teamsTotal=1**(active eligibility 1 lead,team-MISSING ghost 排除)
    expect(data.adopted.teamsTotal).toBe(1);

    // **team-MISSING ghost → failed reason='team-not-found'**(与 'team-archived' 区分)
    expect(data.adopted.failed).toContainEqual({
      sid: 'caller-sid',
      teamId: 'team-MISSING',
      reason: 'team-not-found',
    });
    // **不 push reason='team-archived'**(团队 row 不存在 ≠ archived,语义不混淆)
    expect(data.adopted.failed).not.toContainEqual({
      sid: 'caller-sid',
      teamId: 'team-MISSING',
      reason: 'team-archived',
    });
  });
});
