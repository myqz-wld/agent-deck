/**
 * task tool ingest D7 分流测试（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 19 + §测试矩阵
 * + plan task-team-id-restore-20260525 §Phase G3 v024 重写 D2 + MED-2 修法）。
 *
 * D7 决策：ingest team-task-* AgentEvent **仅在 in-process transport**；
 * HTTP / stdio external transport skip ingest（避免 codex SDK 子进程 SessionDetail
 * 渲染 team-task-* event 未实证风险）。
 *
 * v024 plan §D2 + MED-2 修法（Round 1+3）:teamName 改取 args.teamId lookup
 * （`agentDeckTeamRepo.get(args.teamId)?.name`），不再走 first active team —
 * 多 team caller 显式传 teamId=B（first=A）→ teamName=B。caller 不传 teamId
 * → personal task → teamName=null。
 *
 * 本测试聚焦 ctx.caller.transport 分流 + payload.teamName 取 args.teamId lookup。
 * CRUD 行为 / visible scope / write permission 在 task-crud.test.ts 已覆盖。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

const mocks = vi.hoisted(() => ({
  taskRepo: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reassignOwner: vi.fn(),
  },
  teamRepo: {
    findActiveMembershipsBySession: vi.fn<(sid: string) => unknown[]>(() => []),
    findActiveTeamMembershipsBySession: vi.fn<(sid: string) => unknown[]>(() => []),
    findActiveMembershipsBySessionIds: vi.fn<(sids: string[]) => Map<string, unknown[]>>(
      () => new Map(),
    ),
    findSharedActiveTeams: vi.fn<(a: string, b: string) => unknown[]>(() => []),
    listActiveMembers: vi.fn<(tid: string) => unknown[]>(() => []),
    get: vi.fn<(tid: string) => unknown>(),
  },
  eventBus: { emit: vi.fn() },
  sessionManager: { ingest: vi.fn() },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));
vi.mock('@main/store/task-repo', () => ({ taskRepo: mocks.taskRepo }));
vi.mock('@main/store/agent-deck-team-repo', () => ({ agentDeckTeamRepo: mocks.teamRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));
vi.mock('@main/session/manager', () => ({ sessionManager: mocks.sessionManager }));

const mockTaskRepo = mocks.taskRepo;
const mockTeamRepo = mocks.teamRepo;
const mockEventBus = mocks.eventBus;
const mockSessionManager = mocks.sessionManager;

import { sessionRepo } from '@main/store/session-repo';
const mockSessions = (sessionRepo as unknown as { __sessions: Map<string, unknown> })
  .__sessions;

import { taskCreateHandler } from '../tools/handlers/task-create';
import { taskUpdateHandler } from '../tools/handlers/task-update';
import type { HandlerContext } from '../tools/helpers';

function makeCtx(
  callerSessionId: string,
  transport: HandlerContext['caller']['transport'],
): HandlerContext {
  return { caller: { callerSessionId, transport } };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    ownerSessionId: 'sess-caller',
    subject: 'A',
    description: null,
    status: 'pending',
    activeForm: null,
    priority: 5,
    blocks: [],
    blockedBy: [],
    labels: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  mockTaskRepo.create.mockReset();
  mockTaskRepo.get.mockReset();
  mockTaskRepo.update.mockReset();
  mockTeamRepo.findActiveMembershipsBySession.mockReset().mockReturnValue([]);
  mockTeamRepo.findActiveTeamMembershipsBySession
    .mockReset()
    .mockImplementation((sid: string) => mockTeamRepo.findActiveMembershipsBySession(sid));
  mockTeamRepo.findActiveMembershipsBySessionIds.mockReset().mockReturnValue(new Map());
  mockTeamRepo.findSharedActiveTeams.mockReset().mockReturnValue([]);
  mockEventBus.emit.mockReset();
  mockSessionManager.ingest.mockReset();
  mockSessions.clear();
  mockSessions.set('sess-caller', { id: 'sess-caller', lifecycle: 'active' });
});

describe('task_create — D7 ingest 分流 + v024 D2 teamName 取 args.teamId lookup', () => {
  it('in-process + 传 teamId="team-1" + caller 在 team → ingest team-task-created (payload.teamName = lookup(team-1).name)', async () => {
    // v024 D2: caller 必须在 args.teamId active member（isCallerInTeam check）
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-1', teamName: 'team-A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-1') return { id: tid, name: 'team-A', archivedAt: null };
      return null;
    });
    mockTaskRepo.create.mockReturnValue(
      makeTask({ id: 't1', subject: 'X', ownerSessionId: 'sess-caller', teamId: 'team-1', activeForm: 'agent-A' }),
    );

    await taskCreateHandler({ subject: 'X', teamId: 'team-1' }, makeCtx('sess-caller', 'in-process'));

    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-caller',
        source: 'sdk',
        kind: 'team-task-created',
        payload: expect.objectContaining({
          teamName: 'team-A', // v024 D2: 取 args.teamId lookup
          taskId: 't1',
          description: 'X',
          assignee: 'agent-A',
        }),
      }),
    );
  });

  it('in-process + 不传 teamId（personal task）→ CHANGELOG_165 skip ingest（emit task-changed 仍调）', async () => {
    // v024 D2: 不传 teamId → personal task → teamName=null
    // CHANGELOG_165: personal task 不再 ingest team-task-* event(kind 名与 personal 语义不符
    // + ActivityFeed / TeamDetail EventsSection 噪声),仅 eventBus.emit('task-changed') 保 UI 实时性
    mockTaskRepo.create.mockReturnValue(makeTask({ ownerSessionId: 'sess-caller', teamId: null }));

    await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller', 'in-process'));

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发
    expect(mockSessionManager.ingest).not.toHaveBeenCalled(); // CHANGELOG_165: personal skip ingest
  });

  it('v024 MED-2: multi-team caller 显式 teamId=B（first=A）→ teamName=B（不漂移到 first）', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-A-id', teamName: 'team-A', sessionId: 'sess-caller', role: 'lead' },
      { teamId: 'team-B-id', teamName: 'team-B', sessionId: 'sess-caller', role: 'teammate' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-A-id') return { id: tid, name: 'team-A', archivedAt: null };
      if (tid === 'team-B-id') return { id: tid, name: 'team-B', archivedAt: null };
      return null;
    });
    mockTaskRepo.create.mockReturnValue(
      makeTask({ ownerSessionId: 'sess-caller', teamId: 'team-B-id' }),
    );

    await taskCreateHandler({ subject: 'X', teamId: 'team-B-id' }, makeCtx('sess-caller', 'in-process'));

    expect(mockSessionManager.ingest.mock.calls[0][0].payload.teamName).toBe('team-B');
  });

  it('HTTP transport + team task → skip ingest（D7 分流,与 CHANGELOG_165 personal 守卫独立）', async () => {
    // CHANGELOG_165 fixture 改 team task: personal task 在 in-process 都被 CHANGELOG_165 守卫吞,
    // 此 testcase 用 team task 才能纯证 D7 transport 守卫(HTTP transport 即便 team task 也 skip)
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-1', teamName: 'team-A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-1') return { id: tid, name: 'team-A', archivedAt: null };
      return null;
    });
    mockTaskRepo.create.mockReturnValue(makeTask({ ownerSessionId: 'sess-caller', teamId: 'team-1' }));

    await taskCreateHandler({ subject: 'X', teamId: 'team-1' }, makeCtx('sess-caller', 'http'));

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发（eventBus 不受 D7 影响）
    expect(mockSessionManager.ingest).not.toHaveBeenCalled(); // ingest skip
  });

  // 注：stdio + write tool 在 withMcpGuard 永远 sentinel deny（EXTERNAL_CALLER_ALLOWED.task_create=false）—
  // stdio transport 不存在合法调 write tool 路径；D7 ingest 分流仅在 in-process vs HTTP 之间区分。
});

describe('task_update — D7 ingest 分流（仅 pending→completed 触发）+ v024 D3 写权限校验前置', () => {
  it('in-process + status pending→completed (caller==owner personal) → CHANGELOG_165 skip ingest（emit task-changed 仍调）', async () => {
    // v024 D3: caller==owner personal task 才能写 — 简单路径
    // CHANGELOG_165: personal task 不再 ingest team-task-completed(kind 名与 personal 语义不符);
    // eventBus.emit('task-changed') 仍发保 UI TasksSection 实时性
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'pending', subject: 'work' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'completed', subject: 'work' }),
    );

    await taskUpdateHandler(
      { taskId: 't1', status: 'completed' },
      makeCtx('sess-caller', 'in-process'),
    );

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发
    expect(mockSessionManager.ingest).not.toHaveBeenCalled(); // CHANGELOG_165: personal skip ingest
  });

  it('in-process + team task pending→completed → ingest team-task-completed (teamName=lookup(updated.teamId))', async () => {
    // v024 D3: caller 在 team-1 active member 才能写 team task
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-1', teamName: 'team-A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-1') return { id: tid, name: 'team-A', archivedAt: null };
      return null;
    });
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-1', status: 'pending', subject: 'work' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-1', status: 'completed', subject: 'work' }),
    );

    await taskUpdateHandler(
      { taskId: 't1', status: 'completed' },
      makeCtx('sess-caller', 'in-process'),
    );

    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'team-task-completed',
        payload: expect.objectContaining({
          teamName: 'team-A', // v024: team task → teamName=lookup(updated.teamId).name
        }),
      }),
    );
  });

  it('in-process + status 改非 completed (personal owner) → 不 ingest', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'pending' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'active' }),
    );

    await taskUpdateHandler(
      { taskId: 't1', status: 'active' },
      makeCtx('sess-caller', 'in-process'),
    );

    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('HTTP transport + team task pending→completed → emit task-changed 但 skip ingest (D7 transport 守卫,与 CHANGELOG_165 personal 守卫独立)', async () => {
    // CHANGELOG_165 fixture 改 team task: personal task 在 in-process 都被 CHANGELOG_165 守卫吞,
    // 此 testcase 用 team task 才能纯证 D7 transport 守卫(HTTP transport 即便 team task 也 skip)
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-1', teamName: 'team-A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-1') return { id: tid, name: 'team-A', archivedAt: null };
      return null;
    });
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-1', status: 'pending' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-1', status: 'completed' }),
    );

    await taskUpdateHandler(
      { taskId: 't1', status: 'completed' },
      makeCtx('sess-caller', 'http'),
    );

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
  });
});
