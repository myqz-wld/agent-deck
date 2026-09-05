import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../tools/helpers';
import {
  mockTaskRepo,
  mockTeamRepo,
  mockEventBus,
  mockSessionManager,
  mockSessions,
  makeCtx,
  makeTaskRecord,
  setupCallerInTeam,
  taskCreateHandler,
  taskUpdateHandler,
} from './task-crud.fixture';

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
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/not an active member of teamId "team-A"/);
    expect(payload.hint).toMatch(/Omit teamId.*personal task.*active team ID/);
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
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe('unknown callerSessionId: sess-tempkey');
    expect(payload.hint).toMatch(/per-session MCP token/);
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
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/permission denied/);
    expect(payload.hint).toMatch(/task_list.*active team member session.*owner session/);
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
    expect(JSON.parse(result.content[0].text).hint).toMatch(
      /task_list.*active team member session.*owner session/,
    );
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
    expect(JSON.parse(result.content[0].text).hint).toMatch(
      /task_list.*active team member session.*owner session/,
    );
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
    expect(JSON.parse(result.content[0].text).hint).toMatch(
      /active team ID.*teamId=null.*task owner/,
    );
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
    expect(data.hint).toMatch(/Only ownerSessionId may set teamId=null/);
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
    expect(JSON.parse(result.content[0].text).hint).toMatch(/Call task_list/);
  });
});
