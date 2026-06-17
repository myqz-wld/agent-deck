/**
 * task tool CRUD 核心测试（plan task-team-id-restore-20260525 §Phase G3 大改造 — v024 重写）。
 *
 * 覆盖 5 handler 核心行为（v024 plan §D1-D8 重设计）：
 * - task_create:
 *   - 不传 teamId → personal task（不调 isCallerInTeam）
 *   - 传 teamId + caller 在 team active member → ALLOW + ingest payload.teamName=lookup(teamId)
 *   - 传 teamId + caller 不在 team → reject（D3 写权限校验）
 *   - multi-team caller 显式 teamId=B（first active team=A） → ingest payload.teamName=B（MED-2 修法）
 * - task_update / task_delete (D3 写权限改造):
 *   - personal task (teamId=null) + caller == owner → ALLOW
 *   - personal task + caller != owner → reject（personal 不开放同 team 共享）
 *   - team task + caller 在 team active member → ALLOW（不论 owner）
 *   - team task + caller 不在 team → reject
 *   - task_update.patch.teamId 改 string → caller 必须在新 team active member
 *   - task_delete cascade predicate signature 改 (id, child) 接收 child 完整 task（HIGH-2）
 * - task_get (D8 team-scoped read):
 *   - 与 write 对称（read/write 镜像）— team-bound active member / personal owner
 *   - v023 cross-team 可读 use case 推翻
 * - task_list (D5 三态分流):
 *   - 不传 teamIdFilter → getVisibleTaskScope 走 visibleScope OR 模式
 *   - 传具体 teamId → 校验 caller 在 team active 后用 teamIdFilter
 *   - 传 'null-personal' → ownerSessionIds=[caller] + teamIdFilter='null-personal'
 *   - archived team filter（caller 在 archived team 的 ghost membership 不进 scope）
 *   - member left_at + team archived 双路径独立覆盖（plan §不变量 13 + 已知踩坑 2）
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
    applyHandOffSkipPolicy: vi.fn(),
    findOwnedDistinctTeamIds: vi.fn(() => [] as string[]),
  },
  teamRepo: {
    findActiveMembershipsBySession: vi.fn<(sid: string) => Array<{ teamId: string; teamName: string; sessionId: string; role: string }>>(() => []),
    findActiveTeamMembershipsBySession: vi.fn<(sid: string) => Array<{ teamId: string; teamName: string; sessionId: string; role: string }>>(() => []),
    findActiveMembershipsBySessionIds: vi.fn<(sids: string[]) => Map<string, unknown[]>>(
      () => new Map(),
    ),
    findSharedActiveTeams: vi.fn<(a: string, b: string) => unknown[]>(() => []),
    listActiveMembers: vi.fn<(tid: string) => unknown[]>(() => []),
    get: vi.fn<(tid: string) => { id: string; name: string; archivedAt: number | null } | null>(),
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
    teamId: null,
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

/** mock helper: caller 是 team-A active member（团队也 active）*/
function setupCallerInTeam(callerSid: string, teamId: string, teamName = teamId): void {
  mockTeamRepo.findActiveMembershipsBySession.mockImplementation((sid: string) => {
    if (sid === callerSid) {
      return [{ teamId, teamName, sessionId: sid, role: 'lead' }];
    }
    return [];
  });
  mockTeamRepo.get.mockImplementation((tid: string) => {
    if (tid === teamId) return { id: tid, name: teamName, archivedAt: null };
    return null;
  });
}

beforeEach(() => {
  mockTaskRepo.create.mockReset();
  mockTaskRepo.get.mockReset();
  mockTaskRepo.list.mockReset();
  mockTaskRepo.update.mockReset();
  mockTaskRepo.delete.mockReset();
  mockTeamRepo.findActiveMembershipsBySession.mockReset().mockReturnValue([]);
  mockTeamRepo.findActiveTeamMembershipsBySession
    .mockReset()
    .mockImplementation((sid: string) => mockTeamRepo.findActiveMembershipsBySession(sid));
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

describe('task_create — v024 D1+D2 personal default + D3 teamId 校验', () => {
  it('不传 teamId → 闭包注入 ownerSessionId + teamId=null personal + emit task-changed + CHANGELOG_165 skip ingest team-task-created', async () => {
    const created = makeTaskRecord({ id: 't1', subject: 'X', ownerSessionId: 'sess-caller', teamId: null });
    mockTaskRepo.create.mockReturnValue(created);

    const result = await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'X',
        ownerSessionId: 'sess-caller',
        teamId: null,
      }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'created', taskId: 't1', ownerSessionId: 'sess-caller' }),
    );
    // CHANGELOG_165: personal task (teamId=null) 不再 ingest team-task-created
    // (kind 名与 personal 语义不符;eventBus.emit 仍发保 UI 实时性)
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });

  it('传 teamId + caller 在 team active member → ALLOW + ingest teamName=lookup(teamId).name', async () => {
    setupCallerInTeam('sess-caller', 'team-A', 'Team Alpha');
    const created = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' });
    mockTaskRepo.create.mockReturnValue(created);

    const result = await taskCreateHandler(
      { subject: 'X', teamId: 'team-A' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    // v024 MED-2: teamName 取 args.teamId lookup（不走 first active team）
    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ teamName: 'Team Alpha' }),
      }),
    );
  });

  it('传 teamId + caller 不在 team active member → reject + 不调 repo.create', async () => {
    // caller 不在任何 team
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);
    const result = await taskCreateHandler(
      { subject: 'X', teamId: 'team-A' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/not an active member of teamId "team-A"/);
    expect(mockTaskRepo.create).not.toHaveBeenCalled();
  });

  it('v024 MED-2: multi-team caller 显式 teamId=B（first active=A）→ ingest teamName 取 args.teamId lookup=B', async () => {
    // caller 在 team-A + team-B 两个 team
    mockTeamRepo.findActiveMembershipsBySession.mockImplementation((sid: string) => {
      if (sid === 'sess-caller') {
        return [
          { teamId: 'team-A', teamName: 'Team A', sessionId: sid, role: 'lead' }, // first
          { teamId: 'team-B', teamName: 'Team B', sessionId: sid, role: 'teammate' },
        ];
      }
      return [];
    });
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-A') return { id: tid, name: 'Team A', archivedAt: null };
      if (tid === 'team-B') return { id: tid, name: 'Team B', archivedAt: null };
      return null;
    });
    const created = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-B' });
    mockTaskRepo.create.mockReturnValue(created);

    await taskCreateHandler({ subject: 'X', teamId: 'team-B' }, makeCtx('sess-caller'));

    // 关键：teamName 取 'Team B'（args.teamId lookup），不漂移到 first active 'Team A'
    expect(mockSessionManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ teamName: 'Team B' }),
      }),
    );
  });

  it('caller session 不在 sessions 表（tempKey 窗口）→ isError + 不调 repo.create', async () => {
    mockSessions.clear();
    const result = await taskCreateHandler({ subject: 'X' }, makeCtx('sess-tempkey'));

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.create).not.toHaveBeenCalled();
  });

  it('D7：HTTP transport + team task → emit task-changed 但 skip ingest（与 CHANGELOG_165 personal 守卫独立）', async () => {
    // CHANGELOG_165 fixture 改 team task: personal 在 in-process 都被 CHANGELOG_165 守卫吞,
    // 此 testcase 用 team task 才能纯证 D7 transport 守卫(HTTP transport 即便 team task 也 skip)
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-A', teamName: 'Team Alpha', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-A') return { id: tid, name: 'Team Alpha', archivedAt: null };
      return null;
    });
    mockTaskRepo.create.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'sess-caller', transport: 'http' },
    };

    await taskCreateHandler({ subject: 'X', teamId: 'team-A' }, ctx);

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
  });

  // REVIEW_87 LOW (reviewer-claude): teamId='' 归一到 null（不建畸形 teamId='' task）。
  // schema .min(1) 当前挡空串，本测纵深防御 handler 自身行为（绕过 schema 直调 handler）。
  it('LOW: teamId="" 空串 → 归一到 null personal task（不跳 isCallerInTeam 后落畸形 teamId=""）', async () => {
    const created = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null });
    mockTaskRepo.create.mockReturnValue(created);

    const result = await taskCreateHandler(
      { subject: 'X', teamId: '' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    // 关键：空串归一到 null（修前 truthy check 跳校验 + '' ?? null = '' 建畸形 task）
    expect(mockTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: null }),
    );
    // 归一 null → personal → 不调 isCallerInTeam（findActiveMembershipsBySession 不被触发当校验）
    // 也不 ingest（personal task）
    expect(mockSessionManager.ingest).not.toHaveBeenCalled();
  });
});

describe('task_update — v024 D3 write permission (team-scoped)', () => {
  it('personal task (teamId=null) + caller == owner → ALLOW', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'pending' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null, status: 'completed' }),
    );

    await taskUpdateHandler({ taskId: 't1', status: 'completed' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  it('personal task + caller != owner → reject（D3 personal 不开放同 team 共享）', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger', teamId: null }),
    );
    // caller 即使在 stranger 的某 team 也不允许写 personal task
    setupCallerInTeam('sess-caller', 'team-A');

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'completed' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/permission denied/);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('team task + caller 在 team active member → ALLOW（不论 owner）', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A', status: 'active' }),
    );
    setupCallerInTeam('sess-caller', 'team-A');

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'active' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  it('team task + caller 不在 team → reject', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger', teamId: 'team-A' }),
    );
    // caller 不在 team-A
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'completed' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('member left_at 路径：caller leave team → list/get/update 全 reject（plan §已知踩坑 2）', async () => {
    // findActiveMembershipsBySession 已 SQL filter left_at IS NULL，所以 caller 离队后返空数组
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' }),
    );
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]); // 模拟 left_at

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'active' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('team archived 路径：active-team membership query 排除 archived team → reject', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' }),
    );
    // row-active membership 仍在，但 active-team 查询会排除 archived team。
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-A', teamName: 'A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.findActiveTeamMembershipsBySession.mockReturnValue([]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-A')
        return { id: tid, name: 'A', archivedAt: Date.now() - 1000 }; // 已归档
      return null;
    });

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'active' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('patch.teamId 改 string → caller 必须在新 team active member', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );
    // caller 不在 team-B
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskUpdateHandler(
      { taskId: 't1', teamId: 'team-B' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('patch.teamId = null（改 personal）→ 任何 owner 可改', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );

    const result = await taskUpdateHandler(
      { taskId: 't1', teamId: null },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  // REVIEW_87 MED (reviewer-codex + reviewer-claude 反驳轮共识): team-bound → personal 转换
  // 必须 caller == owner，否则非 owner team member 可私吞共享 task 成原 owner personal task。
  it('MED: 非 owner team member 把 team task 转 personal → permission denied + 不调 update', async () => {
    // caller 是 team-A active member（非 owner），task owner 是 sess-mate
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' }),
    );

    const result = await taskUpdateHandler(
      { taskId: 't1', teamId: null }, // 试图把他人共享 task 转 personal
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toMatch(/cannot convert team task .* to personal/);
    // 关键：repo.update 根本没被调（攻击在权限层被挡）
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
  });

  it('MED 不误伤：owner 自己把 team task 转 personal → ALLOW', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    mockTaskRepo.update.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );

    const result = await taskUpdateHandler(
      { taskId: 't1', teamId: null },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockTaskRepo.update).toHaveBeenCalled();
  });

  // REVIEW_87 LOW (reviewer-codex): 空 patch（仅 taskId 无任何字段）→ 不调 update + 不 emit。
  it('LOW: task_update({taskId}) 空 patch → 返 ok existing + 不 emit task-changed + 不调 repo.update', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );

    const result = await taskUpdateHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expect(result.isError).toBeFalsy();
    // 空 patch 不刷 DB（无 realtime 噪声）
    expect(mockTaskRepo.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    mockTaskRepo.get.mockReturnValue(null);
    const result = await taskUpdateHandler(
      { taskId: 'nope', status: 'active' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
  });
});

describe('task_delete — v024 D3 write permission + cascade predicate (HIGH-2)', () => {
  it('personal task + caller == owner + cascade=false → delete 返 [taskId] + emit deleted', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1']);

    await taskDeleteHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.delete).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cascade: false }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'deleted', taskId: 't1' }),
    );
  });

  it('cascade=true 传 predicate (id, child) 接收完整 task — HIGH-2 修法', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1', 't2']);

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.delete.mock.calls[0][1];
    expect(callArgs.cascade).toBe(true);
    expect(typeof callArgs.predicate).toBe('function');

    // v024 HIGH-2: predicate 接收 (id, child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>)
    // team-A child + caller 在 team-A → 允许
    expect(callArgs.predicate('child-1', { ownerSessionId: 'sess-mate', teamId: 'team-A' })).toBe(true);
    // personal child + caller == owner → 允许（personal owner 特例）
    expect(callArgs.predicate('child-2', { ownerSessionId: 'sess-caller', teamId: null })).toBe(true);
    // team-B child + caller 不在 team-B → 不允许
    expect(callArgs.predicate('child-3', { ownerSessionId: 'sess-stranger', teamId: 'team-B' })).toBe(false);
    // personal child + caller != owner → 不允许
    expect(callArgs.predicate('child-4', { ownerSessionId: 'sess-stranger', teamId: null })).toBe(false);
  });

  it('F-D 回归：cascade emit ownerSessionId 用 child 自己 owner 不用 root', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    // chain: t1(caller team-A) → t2(mate team-A) → t3(mate team-A)
    const root = makeTaskRecord({
      id: 't1',
      ownerSessionId: 'sess-caller',
      teamId: 'team-A',
      blocks: ['t2'],
    });
    const child1 = makeTaskRecord({
      id: 't2',
      ownerSessionId: 'sess-mate',
      teamId: 'team-A',
      blocks: ['t3'],
    });
    const child2 = makeTaskRecord({
      id: 't3',
      ownerSessionId: 'sess-mate',
      teamId: 'team-A',
      blocks: [],
    });
    mockTaskRepo.get.mockImplementation((id: string) => {
      if (id === 't1') return root;
      if (id === 't2') return child1;
      if (id === 't3') return child2;
      return null;
    });
    mockTaskRepo.delete.mockReturnValue(['t1', 't2', 't3']);

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    expect(mockEventBus.emit).toHaveBeenCalledTimes(3);
    const calls = mockEventBus.emit.mock.calls;
    expect(calls[0][1]).toMatchObject({ taskId: 't1', ownerSessionId: 'sess-caller' });
    expect(calls[1][1]).toMatchObject({ taskId: 't2', ownerSessionId: 'sess-mate' });
    expect(calls[2][1]).toMatchObject({ taskId: 't3', ownerSessionId: 'sess-mate' });
  });

  it('cross-team owner → permission denied + 不调 repo.delete', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger', teamId: 'team-B' }),
    );
    // caller 不在 team-B
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskDeleteHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expect(result.isError).toBe(true);
    expect(mockTaskRepo.delete).not.toHaveBeenCalled();
  });

  // REVIEW_87 LOW (reviewer-codex + reviewer-claude): handler pre-walk 复用 repo predicate —
  // 越权 child skip 且不展开其下游（与 repo.delete BFS continue 语义对齐）。
  it('LOW: cascade pre-walk 越权 child（跨 team）skip 且不展开下游 grandchild', async () => {
    // caller 在 team-A；chain: t1(caller,team-A) → t2(越权,team-B) → t3(team-B grandchild)
    setupCallerInTeam('sess-caller', 'team-A');
    const root = makeTaskRecord({
      id: 't1',
      ownerSessionId: 'sess-caller',
      teamId: 'team-A',
      blocks: ['t2'],
    });
    const child = makeTaskRecord({
      id: 't2',
      ownerSessionId: 'sess-stranger',
      teamId: 'team-B', // caller 不在 team-B → 越权 child
      blocks: ['t3'],
    });
    const grandchild = makeTaskRecord({ id: 't3', ownerSessionId: 'sess-stranger', teamId: 'team-B' });
    const getCalls: string[] = [];
    mockTaskRepo.get.mockImplementation((id: string) => {
      getCalls.push(id);
      if (id === 't1') return root;
      if (id === 't2') return child;
      if (id === 't3') return grandchild;
      return null;
    });
    mockTaskRepo.delete.mockReturnValue(['t1']); // repo 实际只删 root（越权 child skip）

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    // 关键：pre-walk 读了 t2（判定越权）但**没读 t3**（越权 child skip 不展开下游）。
    // 修前 pre-walk 不跑 predicate → 会 queue.push(t2.blocks) 读 t3（越权子图展开）。
    expect(getCalls).toContain('t2');
    expect(getCalls).not.toContain('t3');
  });
});

describe('task_get — v024 D8 team-scoped read（v023 cross-team 可读推翻）', () => {
  it('personal task + caller == owner → ALLOW', async () => {
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null });
    mockTaskRepo.get.mockReturnValue(t);

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBeFalsy();
  });

  it('personal task + caller != owner → reject（D3 personal 不开放共享）', async () => {
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-other', teamId: null });
    mockTaskRepo.get.mockReturnValue(t);

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/permission denied/);
  });

  it('team task + caller 在 team active member → ALLOW（不论 owner）', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' });
    mockTaskRepo.get.mockReturnValue(t);

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBeFalsy();
  });

  it('team task + caller 不在 team → reject（v023 推翻 — 不再 cross-team 可读）', async () => {
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger', teamId: 'team-B' });
    mockTaskRepo.get.mockReturnValue(t);
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/permission denied/);
  });

  it('member left_at 路径：caller leave team → task_get reject（plan §已知踩坑 2 双路径独立）', async () => {
    // findActiveMembershipsBySession SQL filter left_at IS NULL → caller 离队后返空
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' });
    mockTaskRepo.get.mockReturnValue(t);
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]); // 模拟 left_at

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
  });

  it('team archived 路径：active-team membership query 排除 archived team → reject', async () => {
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-mate', teamId: 'team-A' });
    mockTaskRepo.get.mockReturnValue(t);
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-A', teamName: 'A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.findActiveTeamMembershipsBySession.mockReturnValue([]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-A')
        return { id: tid, name: 'A', archivedAt: Date.now() - 1000 };
      return null;
    });

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
  });

  it('caller leave 反向覆盖 case d：team T owner leave → teammate B 仍可 read task（lead 早退 reviewer 接手）— Round 3 MED-2', async () => {
    // task 在 team-A，owner=sess-lead，sess-lead 已 left team-A;
    // teammate B (sess-mate) 仍是 team-A 的 active member → 调 task_get(t1) 仍能拿
    const t = makeTaskRecord({ id: 't1', ownerSessionId: 'sess-lead', teamId: 'team-A' });
    mockTaskRepo.get.mockReturnValue(t);
    // sess-mate 是 caller，仍在 team-A active
    setupCallerInTeam('sess-mate', 'team-A');
    mockSessions.set('sess-mate', { id: 'sess-mate', lifecycle: 'active' });

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-mate'));
    expect(result.isError).toBeFalsy(); // teammate 仍可读（team-level 可见性是 per-active-member）
  });

  it('task 不存在 → isError', async () => {
    mockTaskRepo.get.mockReturnValue(null);
    const result = await taskGetHandler({ taskId: 'nope' }, makeCtx('sess-caller'));
    expect(result.isError).toBe(true);
  });
});

describe('task_list — v024 D5 三态分流', () => {
  it('不传 teamIdFilter → getVisibleTaskScope 走 visibleScope OR 模式', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    // 调用走 visibleScope（不走 ownerSessionIds + teamIdFilter）
    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(callArgs.visibleScope).toBeDefined();
    expect(callArgs.visibleScope.teamIds).toEqual(['team-A']);
    expect(callArgs.visibleScope.callerSid).toBe('sess-caller');
    expect(callArgs.ownerSessionIds).toBeUndefined();
    expect(callArgs.teamIdFilter).toBeUndefined();
  });

  it('caller 无 team → visibleScope.teamIds=[] + callerSid（OR 退化仅 caller personal）', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(callArgs.visibleScope.teamIds).toEqual([]);
    expect(callArgs.visibleScope.callerSid).toBe('sess-caller');
  });

  it('F2 修法：active-team membership query 排除 archived team 的 ghost membership', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-active', teamName: 'A', sessionId: 'sess-caller', role: 'lead' },
      { teamId: 'team-archived', teamName: 'B', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.findActiveTeamMembershipsBySession.mockReturnValue([
      { teamId: 'team-active', teamName: 'A', sessionId: 'sess-caller', role: 'lead' },
    ]);
    mockTeamRepo.get.mockImplementation((tid: string) => {
      if (tid === 'team-active') return { id: tid, name: 'A', archivedAt: null };
      if (tid === 'team-archived')
        return { id: tid, name: 'B', archivedAt: Date.now() - 1000 };
      return null;
    });
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({}, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(callArgs.visibleScope.teamIds).toEqual(['team-active']);
    expect(callArgs.visibleScope.teamIds).not.toContain('team-archived');
  });

  it('传具体 teamId → 校验 caller 在 team active + 用 teamIdFilter', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({ teamIdFilter: 'team-A' }, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(callArgs.teamIdFilter).toBe('team-A');
    expect(callArgs.visibleScope).toBeUndefined();
  });

  it('传具体 teamId + caller 不在 team → reject', async () => {
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskListHandler(
      { teamIdFilter: 'team-A' },
      makeCtx('sess-caller'),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/not an active member of teamId/);
    expect(mockTaskRepo.list).not.toHaveBeenCalled();
  });

  it("传 'null-personal' → ownerSessionIds=[caller] + teamIdFilter='null-personal'", async () => {
    mockTaskRepo.list.mockReturnValue([]);

    await taskListHandler({ teamIdFilter: 'null-personal' }, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.list.mock.calls[0][0];
    expect(callArgs.ownerSessionIds).toEqual(['sess-caller']);
    expect(callArgs.teamIdFilter).toBe('null-personal');
  });

  it('F4：返 { total, hasMore, tasks } — hasMore = tasks.length === effectiveLimit', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    const tasks50 = Array.from({ length: 50 }, (_, i) => makeTaskRecord({ id: `t-${i}` }));
    mockTaskRepo.list.mockReturnValue(tasks50);

    const result = await taskListHandler({ limit: 50 }, makeCtx('sess-caller'));
    const json = JSON.parse(result.content[0].text);

    expect(json.total).toBe(50);
    expect(json.hasMore).toBe(true);

    mockTaskRepo.list.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => makeTaskRecord({ id: `t-${i}` })),
    );
    const r2 = await taskListHandler({ limit: 10 }, makeCtx('sess-caller'));
    expect(JSON.parse(r2.content[0].text).hasMore).toBe(false);
  });
});
