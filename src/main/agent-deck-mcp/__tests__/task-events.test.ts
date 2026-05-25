/**
 * task tool ingest D7 分流测试（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 19 + §测试矩阵
 * + plan task-team-id-restore-20260525 §Phase G3 v024 重写 D2 + MED-2 修法）。
 *
 * D7 决策：ingest team-task-* AgentEvent **仅在 in-process transport**；
 * HTTP / stdio external transport skip ingest（避免 codex SDK 子进程 SessionDetail
 * 渲染 team-task-* event 未实证风险）。
 *
 * v024 plan §D2 + MED-2 修法（Round 1+3）:teamName 改取 args.team_id lookup
 * （`agentDeckTeamRepo.get(args.team_id)?.name`），不再走 first active team —
 * 多 team caller 显式传 team_id=B（first=A）→ teamName=B。caller 不传 team_id
 * → personal task → teamName=null。
 *
 * 本测试聚焦 ctx.caller.transport 分流 + payload.teamName 取 args.team_id lookup。
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
  mockTeamRepo.findActiveMembershipsBySessionIds.mockReset().mockReturnValue(new Map());
  mockTeamRepo.findSharedActiveTeams.mockReset().mockReturnValue([]);
  mockEventBus.emit.mockReset();
  mockSessionManager.ingest.mockReset();
  mockSessions.clear();
  mockSessions.set('sess-caller', { id: 'sess-caller', lifecycle: 'active' });
});

describe('task_create — D7 ingest 分流 + v024 D2 teamName 取 args.team_id lookup', () => {
  it('in-process + 传 team_id="team-1" + caller 在 team → ingest team-task-created (payload.teamName = lookup(team-1).name)', async () => {
    // v024 D2: caller 必须在 args.team_id active member（isCallerInTeam check）
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

    await taskCreateHandler({ subject: 'X', team_id: 'team-1' }, makeCtx('sess-caller', 'in-process'));

    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-caller',
        source: 'sdk',
        kind: 'team-task-created',
        payload: expect.objectContaining({
          teamName: 'team-A', // v024 D2: 取 args.team_id lookup
          taskId: 't1',
          description: 'X',
          assignee: 'agent-A',
        }),
      }),
    );
  });

  it('in-process + 不传 team_id（personal task）→ ingest 但 payload.teamName = null', async () => {
    // v024 D2: 不传 team_id → personal task → teamName=null（不再走 first active team）
    mockTaskRepo.create.mockReturnValue(makeTask({ ownerSessionId: 'sess-caller', teamId: null }));

    await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller', 'in-process'));

    expect(mockSessionManager.ingest).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.ingest.mock.calls[0][0].payload.teamName).toBeNull();
  });

  it('v024 MED-2: multi-team caller 显式 team_id=B（first=A）→ teamName=B（不漂移到 first）', async () => {
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

    await taskCreateHandler({ subject: 'X', team_id: 'team-B-id' }, makeCtx('sess-caller', 'in-process'));

    expect(mockSessionManager.ingest.mock.calls[0][0].payload.teamName).toBe('team-B');
  });

  it('HTTP transport (per-session authn real sid) → skip ingest（D7 分流，与 in-process 对比）', async () => {
    mockTaskRepo.create.mockReturnValue(makeTask({ ownerSessionId: 'sess-caller', teamId: null }));

    await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller', 'http'));

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发（eventBus 不受 D7 影响）
    expect(mockSessionManager.ingest).not.toHaveBeenCalled(); // ingest skip
  });

  // 注：stdio + write tool 在 withMcpGuard 永远 sentinel deny（EXTERNAL_CALLER_ALLOWED.task_create=false）—
  // stdio transport 不存在合法调 write tool 路径；D7 ingest 分流仅在 in-process vs HTTP 之间区分。
});

describe('task_update — D7 ingest 分流（仅 pending→completed 触发）+ v024 D3 写权限校验前置', () => {
  it('in-process + status pending→completed (caller==owner personal) → ingest team-task-completed (teamName=null)', async () => {
    // v024 D3: caller==owner personal task 才能写 — 简单路径
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'pending', subject: 'work' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'completed', subject: 'work' }),
    );

    await taskUpdateHandler(
      { task_id: 't1', status: 'completed' },
      makeCtx('sess-caller', 'in-process'),
    );

    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'team-task-completed',
        payload: expect.objectContaining({
          teamName: null, // v024: personal task → teamName null
          taskId: 't1',
          description: 'work',
        }),
      }),
    );
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
      { task_id: 't1', status: 'completed' },
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
      { task_id: 't1', status: 'active' },
      makeCtx('sess-caller', 'in-process'),
    );

    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('HTTP transport + personal pending→completed → emit task-changed 但 skip ingest', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'pending' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'completed' }),
    );

    await taskUpdateHandler(
      { task_id: 't1', status: 'completed' },
      makeCtx('sess-caller', 'http'),
    );

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
  });
});
