/**
 * task tool CRUD 核心测试（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 18 + §测试矩阵）。
 *
 * 覆盖 5 handler 核心行为：
 * - task_create owner_session_id 闭包注入（D5 caller_session_id 从 ctx.caller 拿）
 * - task_update / task_delete 写权限 same-team check（D2 + caller==owner 特例）
 * - task_get 跨 team 只读
 * - task_list visible scope（caller + 同 active team 成员）
 *
 * **测试策略**：mock taskRepo / sessionRepo / agentDeckTeamRepo / eventBus / sessionManager；
 * 直接调 handler(args, ctx) 验证业务逻辑（绕开 withMcpGuard wrapper deny 链 — 由 helpers/spoofing tests 覆盖）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// vi.hoisted 让 mock objects 在 vi.mock factory 执行前就 ready
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

// 整套 mock — handler 间接 import 这些
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

// import sessionRepo via mock 后 attach __sessions
import { sessionRepo } from '@main/store/session-repo';
const mockSessions = (sessionRepo as unknown as { __sessions: Map<string, unknown> })
  .__sessions;

import { taskCreateHandler } from '../tools/handlers/task-create';
import { taskListHandler } from '../tools/handlers/task-list';
import { taskGetHandler } from '../tools/handlers/task-get';
import { taskUpdateHandler } from '../tools/handlers/task-update';
import { taskDeleteHandler } from '../tools/handlers/task-delete';
import type { HandlerContext } from '../tools/helpers';

function makeCtx(callerSessionId: string): HandlerContext {
  return { caller: { callerSessionId, transport: 'in-process' } };
}

function makeTaskRecord(overrides: Record<string, unknown> = {}) {
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
  mockTaskRepo.list.mockReset();
  mockTaskRepo.update.mockReset();
  mockTaskRepo.delete.mockReset();
  mockTeamRepo.findActiveMembershipsBySession.mockReset().mockReturnValue([]);
  mockTeamRepo.findActiveMembershipsBySessionIds.mockReset().mockReturnValue(new Map());
  mockTeamRepo.findSharedActiveTeams.mockReset().mockReturnValue([]);
  mockTeamRepo.listActiveMembers.mockReset().mockReturnValue([]);
  mockTeamRepo.get.mockReset();
  mockEventBus.emit.mockReset();
  mockSessionManager.ingest.mockReset();
  mockSessions.clear();
  // 默认 caller session 在 sessions 表
  mockSessions.set('sess-caller', { id: 'sess-caller', lifecycle: 'active' });
});

describe('task_create', () => {
  it('闭包注入 ownerSessionId=callerSid + emit task-changed + ingest team-task-created', async () => {
    const created = makeTaskRecord({ id: 't1', subject: 'X', ownerSessionId: 'sess-caller' });
    mockTaskRepo.create.mockReturnValue(created);

    const result = await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'X', ownerSessionId: 'sess-caller' }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'created', taskId: 't1', ownerSessionId: 'sess-caller' }),
    );
    // D7：in-process transport ingest team-task-created
    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-caller',
        kind: 'team-task-created',
      }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('caller session 不在 sessions 表（tempKey 窗口）→ isError + 不调 repo.create', async () => {
    mockSessions.clear();
    const result = await taskCreateHandler({ subject: 'X' }, makeCtx('sess-tempkey'));

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.create).not.toHaveBeenCalled();
  });

  it('D7：HTTP transport (per-session authn real sid) → emit task-changed 但 skip ingest', async () => {
    mockTaskRepo.create.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'sess-caller', transport: 'http' },
    };

    await taskCreateHandler({ subject: 'X' }, ctx);

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
  });
});

describe('task_update — same-team write permission (D2)', () => {
  it('caller == owner → 允许更新（特例直跳）', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', status: 'pending' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', status: 'completed' }),
    );

    await taskUpdateHandler(
      { task_id: 't1', status: 'completed' },
      makeCtx('sess-caller'),
    );

    expect(mockTeamRepo.findSharedActiveTeams).not.toHaveBeenCalled(); // caller==owner 跳
    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  it('caller != owner + same active team → 允许（findSharedActiveTeams 命中）', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', status: 'active' }),
    );
    mockTeamRepo.findSharedActiveTeams.mockReturnValue([
      { teamId: 'team-1', teamName: 't1' },
    ]);

    const result = await taskUpdateHandler(
      { task_id: 't1', status: 'active' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockTeamRepo.findSharedActiveTeams).toHaveBeenCalledWith(
      'sess-caller',
      'sess-mate',
    );
    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  it('caller != owner + 0 shared active team → permission denied', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger' }),
    );
    mockTeamRepo.findSharedActiveTeams.mockReturnValue([]); // 无共享 team

    const result = await taskUpdateHandler(
      { task_id: 't1', status: 'completed' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/permission denied/);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    mockTaskRepo.get.mockReturnValue(null);
    const result = await taskUpdateHandler(
      { task_id: 'nope', status: 'active' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
  });
});

describe('task_delete — same-team write permission (D2) + cascade predicate', () => {
  it('caller == owner + cascade=false → delete 返 [task_id] + emit deleted', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1']);

    await taskDeleteHandler({ task_id: 't1' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.delete).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cascade: false }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'deleted', taskId: 't1' }),
    );
  });

  it('cascade=true 传 predicate (id, ownerSid) closure 写权限', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1', 't2']);

    await taskDeleteHandler(
      { task_id: 't1', force: true },
      makeCtx('sess-caller'),
    );

    const callArgs = mockTaskRepo.delete.mock.calls[0][1];
    expect(callArgs.cascade).toBe(true);
    expect(typeof callArgs.predicate).toBe('function');
    // predicate(_, ownerSid) — caller==owner 特例直跳
    expect(callArgs.predicate('child-1', 'sess-caller')).toBe(true);
    // predicate(_, stranger) → 走 findSharedActiveTeams
    mockTeamRepo.findSharedActiveTeams.mockReturnValue([]);
    expect(callArgs.predicate('child-2', 'sess-stranger')).toBe(false);
  });

  // R1-mixed-codex-LOW-D 修法回归：cascade delete 同 team 不同 owner 的 child 时 emit
  // 应用 child 自己 ownerSessionId（不是 root target.ownerSessionId）。修前 bug：
  // 所有 deleted ids emit ownerSessionId = target.ownerSessionId → consumer 按 owner
  // 过滤漏刷新 child owner 视图。TaskChangedEvent contract 明示 deleted 取自被删 task
  // 原 owner (src/shared/types/task.ts:53)。
  it('F-D 回归：cascade emit ownerSessionId 用 child 自己 owner 不用 root', async () => {
    // chain: t1(caller) → t2(mate, same-team) → t3(mate)
    const root = makeTaskRecord({
      id: 't1',
      ownerSessionId: 'sess-caller',
      blocks: ['t2'],
    });
    const child1 = makeTaskRecord({
      id: 't2',
      ownerSessionId: 'sess-mate',
      blocks: ['t3'],
    });
    const child2 = makeTaskRecord({
      id: 't3',
      ownerSessionId: 'sess-mate',
      blocks: [],
    });
    mockTaskRepo.get.mockImplementation((id: string) => {
      if (id === 't1') return root;
      if (id === 't2') return child1;
      if (id === 't3') return child2;
      return null;
    });
    mockTaskRepo.delete.mockReturnValue(['t1', 't2', 't3']);
    mockTeamRepo.findSharedActiveTeams.mockReturnValue([
      { teamId: 'team-1', teamName: 't' },
    ]);

    await taskDeleteHandler(
      { task_id: 't1', force: true },
      makeCtx('sess-caller'),
    );

    expect(mockEventBus.emit).toHaveBeenCalledTimes(3);
    const calls = mockEventBus.emit.mock.calls;
    // root t1 → ownerSessionId = sess-caller (root owner)
    expect(calls[0][1]).toMatchObject({
      taskId: 't1',
      ownerSessionId: 'sess-caller',
    });
    // child t2 / t3 → ownerSessionId = sess-mate (child owner，不是 root sess-caller)
    expect(calls[1][1]).toMatchObject({
      taskId: 't2',
      ownerSessionId: 'sess-mate',
    });
    expect(calls[2][1]).toMatchObject({
      taskId: 't3',
      ownerSessionId: 'sess-mate',
    });
  });

  it('cross-team owner → permission denied + 不调 repo.delete', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger' }),
    );
    mockTeamRepo.findSharedActiveTeams.mockReturnValue([]);

    const result = await taskDeleteHandler({ task_id: 't1' }, makeCtx('sess-caller'));

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.delete).not.toHaveBeenCalled();
  });
});

describe('task_get — 跨 team 只读', () => {
  it('返 task 不限 owner / team', async () => {
    const stranger = makeTaskRecord({ id: 't-other', ownerSessionId: 'sess-stranger' });
    mockTaskRepo.get.mockReturnValue(stranger);

    const result = await taskGetHandler({ task_id: 't-other' }, makeCtx('sess-caller'));

    expect(result.isError).toBeFalsy();
    // 不调 team check
    expect(mockTeamRepo.findSharedActiveTeams).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    mockTaskRepo.get.mockReturnValue(null);
    const result = await taskGetHandler({ task_id: 'nope' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
  });
});

describe('task_list — visible scope (D6)', () => {
  it('caller 无 team → ownerSessionIds = [callerSid]', async () => {
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    expect(mockTaskRepo.list).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionIds: ['sess-caller'] }),
    );
  });

  it('caller 在单 active team → ownerSessionIds = caller + 同 team active member', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-1', teamName: 't1', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockReturnValue({ id: 'team-1', archivedAt: null, name: 't1' });
    mockTeamRepo.listActiveMembers.mockReturnValue([
      { sessionId: 'sess-caller' },
      { sessionId: 'sess-mate-A' },
    ]);
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(new Set(callArgs.ownerSessionIds)).toEqual(
      new Set(['sess-caller', 'sess-mate-A']),
    );
  });

  it('F2 修法：caller 在 archived team 的 ghost membership 不进 visible scope', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-active', teamName: 't-a', sessionId: 'sess-caller', role: 'lead' },
      {
        teamId: 'team-archived',
        teamName: 't-arch',
        sessionId: 'sess-caller',
        role: 'lead',
      },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-active') return { id: tid, archivedAt: null, name: tid };
      if (tid === 'team-archived')
        return { id: tid, archivedAt: Date.now() - 1000, name: tid };
      return null;
    });
    mockTeamRepo.listActiveMembers.mockImplementation((tid: string) => {
      if (tid === 'team-active')
        return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-A' }];
      if (tid === 'team-archived')
        return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-archived-mate' }];
      return [];
    });
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(new Set(callArgs.ownerSessionIds)).toEqual(
      new Set(['sess-caller', 'sess-A']),
    );
    expect(callArgs.ownerSessionIds).not.toContain('sess-archived-mate');
    expect(mockTeamRepo.listActiveMembers).not.toHaveBeenCalledWith('team-archived');
  });

  it('F4：返 { total, hasMore, tasks } — hasMore = tasks.length === effectiveLimit', async () => {
    const tasks50 = Array.from({ length: 50 }, (_, i) => makeTaskRecord({ id: `t-${i}` }));
    mockTaskRepo.list.mockReturnValue(tasks50);

    const result = await taskListHandler({ limit: 50 }, makeCtx('sess-caller'));
    const json = JSON.parse(result.content[0].text);

    expect(json.total).toBe(50);
    expect(json.hasMore).toBe(true);

    // 同 caller，5 条 < limit → hasMore=false
    mockTaskRepo.list.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => makeTaskRecord({ id: `t-${i}` })),
    );
    const r2 = await taskListHandler({ limit: 10 }, makeCtx('sess-caller'));
    expect(JSON.parse(r2.content[0].text).hasMore).toBe(false);
  });
});
