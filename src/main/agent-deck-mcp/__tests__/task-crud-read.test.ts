import { describe, expect, it } from 'vitest';
import {
  mockTaskRepo,
  mockTeamRepo,
  mockSessions,
  makeCtx,
  makeTaskRecord,
  setupCallerInTeam,
  taskCreateHandler,
  taskListHandler,
  taskGetHandler,
  taskUpdateHandler,
  taskDeleteHandler,
} from './task-crud.fixture';

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
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/permission denied/);
    expect(payload.hint).toMatch(/task_list.*active team membership.*ownerSessionId/);
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
    expect(JSON.parse(result.content[0].text).hint).toMatch(/Call task_list/);
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
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/not an active member of teamId/);
    expect(payload.hint).toMatch(/Omit teamIdFilter.*"null-personal".*Agent Deck UI/);
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
    expect(result.content).toEqual([]);
    const json = result.structuredContent!;

    expect(json.total).toBe(50);
    expect(json.hasMore).toBe(true);

    mockTaskRepo.list.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => makeTaskRecord({ id: `t-${i}` })),
    );
    const r2 = await taskListHandler({ limit: 10 }, makeCtx('sess-caller'));
    expect(r2.content).toEqual([]);
    expect(r2.structuredContent?.hasMore).toBe(false);
  });
});

describe('task handler internal error guidance', () => {
  const expectStorageFailure = (
    result: { isError?: boolean; content: Array<{ text: string }> },
    error: string,
  ): void => {
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe(error);
    expect(payload.hint).toMatch(/transient storage error.*retry once.*main-process logs/);
  };

  it('task_create preserves the storage error and adds bounded retry guidance', async () => {
    mockTaskRepo.create.mockImplementationOnce(() => {
      throw new Error('task create storage failed');
    });

    const result = await taskCreateHandler({ subject: 'X' }, makeCtx('sess-caller'));

    expectStorageFailure(result, 'task create storage failed');
  });

  it('task_get preserves the storage error and adds bounded retry guidance', async () => {
    mockTaskRepo.get.mockImplementationOnce(() => {
      throw new Error('task get storage failed');
    });

    const result = await taskGetHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expectStorageFailure(result, 'task get storage failed');
  });

  it('task_update preserves the storage error and adds bounded retry guidance', async () => {
    mockTaskRepo.get.mockImplementationOnce(() => {
      throw new Error('task update storage failed');
    });

    const result = await taskUpdateHandler(
      { taskId: 't1', status: 'active' },
      makeCtx('sess-caller'),
    );

    expectStorageFailure(result, 'task update storage failed');
  });

  it('task_delete preserves the storage error and adds bounded retry guidance', async () => {
    mockTaskRepo.get.mockImplementationOnce(() => {
      throw new Error('task delete storage failed');
    });

    const result = await taskDeleteHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expectStorageFailure(result, 'task delete storage failed');
  });

  it('task_list preserves the storage error and adds bounded retry guidance', async () => {
    mockTaskRepo.list.mockImplementationOnce(() => {
      throw new Error('task list storage failed');
    });

    const result = await taskListHandler({}, makeCtx('sess-caller'));

    expectStorageFailure(result, 'task list storage failed');
  });
});
