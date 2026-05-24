/**
 * Task Manager tools.ts 写操作单测（plan task-mcp-owner-session-id-rewrite-20260521 v023 重写）。
 *
 * 范围：buildTaskTools 形状校验 + task_create / task_update / task_delete 三个写工具的
 * v023 行为 — owner_session_id 闭包注入 + same-team 写权限校验 + emit task-changed 事件断言。
 *
 * 不依赖 better-sqlite3 binding，也不依赖真 SDK：
 * - mock `@main/adapters/claude-code/sdk-loader` 让 `tool()` 返回一个透明对象
 *   `{ name, description, inputSchema, handler }`，测试直接拿 handler 调
 * - mock `@main/event-bus` / `@main/session/manager` 让 emit / ingest 变成 vi.fn() 断言
 * - mock `@main/store/session-repo` 让 task_create 的 FK 兜底通过
 * - mock `@main/store/agent-deck-team-repo` 让 isCallerAuthorizedToWrite (走
 *   findSharedActiveTeams) + getCallerFirstTeamName 可控
 * - mock `TaskRepo` 用 vi.fn() 替全部方法
 *
 * 覆盖点（plan §D1-D6 + §不变量）：
 * - closure owner_session_id 注入：task_create 强制 owner = callerSid（args 不暴露）
 * - task_create caller session 不在 sessions 表 → isError（tempKey 窗口兜底）
 * - 写权限 same-team check：caller == owner / cross-team 拒
 * - cascade delete predicate 签名 (id, ownerSessionId) 闭包写权限
 * - 写操作 emit task-changed 事件 + ingest team-task-* AgentEvent（在 tools.read-ingest.test.ts）
 *
 * task_list / task_get + ingest 在同目录 tools.read-ingest.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@shared/types';
import type { TaskRepo } from '@main/store/task-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeEventBusMock } from '@main/__tests__/_shared/mocks/event-bus';

// ──────────────── module mocks ────────────────
vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock());

// event-bus: emit 变成 spy 函数
const emitSpy = vi.fn();
vi.mock('@main/event-bus', () => ({
  eventBus: makeEventBusMock({
    overrides: {
      emit: (...args: unknown[]) => emitSpy(...args),
    },
  }),
}));

// session/manager: ingest 变成 spy
const ingestSpy = vi.fn();
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    ingest: (...args: unknown[]) => ingestSpy(...args),
  },
  setSessionCloseFn: vi.fn(),
}));

// session-repo: get(callerSid) 返回非 null 让 task_create FK 兜底通过；
// 测试 tempKey 场景时 mockReturnValue(null)
const sessionGetSpy = vi.fn();
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sid: string) => sessionGetSpy(sid),
  },
}));

// agent-deck-team-repo: isCallerAuthorizedToWrite (findSharedActiveTeams) +
// getCallerFirstTeamName (findActiveMembershipsBySessionIds) 全 spy
const findSharedActiveTeamsSpy = vi.fn();
const findActiveMembershipsBySessionIdsSpy = vi.fn();
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    findSharedActiveTeams: (a: string, b: string) => findSharedActiveTeamsSpy(a, b),
    findActiveMembershipsBySessionIds: (sids: string[]) =>
      findActiveMembershipsBySessionIdsSpy(sids),
    // task_list 用的两个（tools.read-ingest.test.ts 覆盖；crud 测试不直接走 list）
    findActiveMembershipsBySession: vi.fn().mockReturnValue([]),
    listActiveMembers: vi.fn().mockReturnValue([]),
  },
}));

// 在 mock 完后才能 import 被测对象（hoisting safe pattern）
import { buildTaskTools } from '../tools';

// ──────────────── helpers ────────────────
function makeMockRepo(): TaskRepo {
  return {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reassignOwner: vi.fn(),
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'task-1',
    ownerSessionId: overrides.ownerSessionId ?? 'sess-caller',
    subject: overrides.subject ?? 'A',
    description: overrides.description ?? null,
    status: overrides.status ?? 'pending',
    activeForm: overrides.activeForm ?? null,
    priority: overrides.priority ?? 5,
    blocks: overrides.blocks ?? [],
    blockedBy: overrides.blockedBy ?? [],
    labels: overrides.labels ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

/**
 * v023 改：buildTaskTools 第二参从 teamIdProvider 改 sessionIdProvider。
 * helper 包成 () => sid 工厂。
 */
async function buildToolsAsDict(repo: TaskRepo, callerSid: string | null) {
  const arr = await buildTaskTools(repo, () => callerSid);
  const dict: Record<string, (typeof arr)[number]> = {};
  for (const t of arr) dict[t.name] = t;
  return dict;
}

beforeEach(() => {
  emitSpy.mockReset();
  ingestSpy.mockReset();
  sessionGetSpy.mockReset();
  findSharedActiveTeamsSpy.mockReset();
  findActiveMembershipsBySessionIdsSpy.mockReset();
  // 默认 caller session 存在（让 task_create FK 兜底通过）
  sessionGetSpy.mockReturnValue({ id: 'sess-caller' });
  // 默认 caller 无 active team（getCallerFirstTeamName 返 null）
  findActiveMembershipsBySessionIdsSpy.mockReturnValue(new Map());
});

// ──────────────── tests ────────────────
describe('buildTaskTools / 工具集合形状', () => {
  it('返回恰好 5 个工具，名字与 spec 一致', async () => {
    const tools = await buildTaskTools(makeMockRepo(), () => 'sess-caller');
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'task_create',
      'task_delete',
      'task_get',
      'task_list',
      'task_update',
    ]);
  });

  it('task_create schema 不暴露 owner 字段（v023 §不变量 1：owner 闭包注入）', async () => {
    const tools = await buildToolsAsDict(makeMockRepo(), 'sess-caller');
    const keys = Object.keys(tools.task_create.inputSchema as object);
    expect(keys).not.toContain('owner_session_id');
    expect(keys).not.toContain('owner');
    expect(keys).not.toContain('team_id');
    expect(keys).not.toContain('team_name');
  });

  it('task_update / task_delete schema 不暴露 owner 字段', async () => {
    const tools = await buildToolsAsDict(makeMockRepo(), 'sess-caller');
    const updateKeys = Object.keys(tools.task_update.inputSchema as object);
    const deleteKeys = Object.keys(tools.task_delete.inputSchema as object);
    expect(updateKeys).not.toContain('owner_session_id');
    expect(updateKeys).not.toContain('team_id');
    expect(deleteKeys).not.toContain('owner_session_id');
    expect(deleteKeys).not.toContain('team_id');
  });

  it('task_list schema 不暴露 team_id（v023 改 reverse join，visibility caller-driven）', async () => {
    const tools = await buildToolsAsDict(makeMockRepo(), 'sess-caller');
    const keys = Object.keys(tools.task_list.inputSchema as object);
    expect(keys).not.toContain('team_id');
    expect(keys).not.toContain('owner_session_id');
  });

  it('lazy provider 在多次调用之间返回不同值（同 CHANGELOG_46 lazy 关键 gain）', async () => {
    const repo = makeMockRepo();
    let currentSid: string | null = 'sess-A';
    sessionGetSpy.mockImplementation((sid) => (sid ? { id: sid } : null));
    const tools = await buildTaskTools(repo, () => currentSid);
    const dict: Record<string, (typeof tools)[number]> = {};
    for (const t of tools) dict[t.name] = t;

    // 第 1 次调 task_create：provider 返回 sess-A
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeTask({ id: 't-1', ownerSessionId: 'sess-A' }),
    );
    await dict.task_create.handler({ subject: 'X' }, undefined);
    expect(repo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerSessionId: 'sess-A' }),
    );

    // provider 切换到 sess-B
    currentSid = 'sess-B';

    // 第 2 次调 task_create：provider 返回 sess-B
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeTask({ id: 't-2', ownerSessionId: 'sess-B' }),
    );
    await dict.task_create.handler({ subject: 'Y' }, undefined);
    expect(repo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerSessionId: 'sess-B' }),
    );
  });
});

describe('task_create', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
  });

  it('强制 closure 注入 ownerSessionId = callerSid（v023 §不变量 1）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const created = makeTask({ id: 't1', subject: 'X', ownerSessionId: 'sess-caller' });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'X', ownerSessionId: 'sess-caller' }),
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('callerSid null（tempKey 窗口）→ isError', async () => {
    const tools = await buildToolsAsDict(repo, null);

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('caller session 不在 sessions 表（tempKey 窗口）→ isError + 友好错误', async () => {
    sessionGetSpy.mockReturnValue(null);
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('成功后 emit task-changed { kind: created, ownerSessionId }', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const created = makeTask({ id: 't1', ownerSessionId: 'sess-caller' });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({
        kind: 'created',
        taskId: 't1',
        task: created,
        ownerSessionId: 'sess-caller',
      }),
    );
  });

  it('repo.create 抛错时返回 isError + 不 emit', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('subject 不能为空');
    });

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('task_update / 写权限锁（v023 §D2 same-team check）', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
  });

  it('caller == owner → 允许更新 + emit（特例：自己改自己 task）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const before = makeTask({ id: 't1', ownerSessionId: 'sess-caller', status: 'pending' });
    const after = makeTask({ id: 't1', ownerSessionId: 'sess-caller', status: 'completed' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    const result = await tools.task_update.handler(
      { task_id: 't1', status: 'completed' },
      undefined,
    );

    expect(repo.update).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: 'completed' }),
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    // caller == owner 特例不走 findSharedActiveTeams
    expect(findSharedActiveTeamsSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'updated', task: after }),
    );
  });

  it('caller != owner 但 same team → 允许更新（v023 §D2 same-team 都能写）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-other' }),
    );
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-other', status: 'completed' }),
    );
    // mock 共享 1 个 active team
    findSharedActiveTeamsSpy.mockReturnValue([{ teamId: 'team-1', teamName: 't1' }]);

    const result = await tools.task_update.handler(
      { task_id: 't1', status: 'completed' },
      undefined,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(findSharedActiveTeamsSpy).toHaveBeenCalledWith('sess-caller', 'sess-other');
    expect(repo.update).toHaveBeenCalled();
  });

  it('caller != owner 且 cross team（无共享 active team）→ isError + 不调 repo.update', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-other' }),
    );
    findSharedActiveTeamsSpy.mockReturnValue([]); // 无共享

    const result = await tools.task_update.handler(
      { task_id: 't1', status: 'completed' },
      undefined,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await tools.task_update.handler(
      { task_id: 'nope', status: 'active' },
      undefined,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('callerSid null → isError', async () => {
    const tools = await buildToolsAsDict(repo, null);
    const result = await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe('task_delete / 写权限锁（v023 §D2 same-team check）', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
  });

  it('caller == owner → 允许删 + emit', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(repo.delete).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cascade: false }),
    );
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({
        kind: 'deleted',
        taskId: 't1',
        ownerSessionId: 'sess-caller',
      }),
    );
  });

  it('caller != owner 且 cross team → isError + 不调 repo.delete', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-other' }),
    );
    findSharedActiveTeamsSpy.mockReturnValue([]);

    const result = await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('force=true 透传 cascade=true', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    expect(repo.delete).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cascade: true }),
    );
  });

  it('v023 §D2：cascade 时给 repo.delete 传 (id, ownerSessionId) predicate 闭包写权限', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    const callArgs = (repo.delete as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      cascade: boolean;
      predicate: (id: string, ownerSid: string) => boolean;
    };
    expect(typeof callArgs.predicate).toBe('function');

    // predicate('child-id', 'sess-caller') → caller == owner 特例直接 true（不查 share）
    findSharedActiveTeamsSpy.mockReset();
    expect(callArgs.predicate('child-id', 'sess-caller')).toBe(true);

    // predicate('child-id', 'sess-friend') → 查 findSharedActiveTeams，有共享 = true
    findSharedActiveTeamsSpy.mockReturnValue([{ teamId: 'team-1', teamName: 't1' }]);
    expect(callArgs.predicate('child-id', 'sess-friend')).toBe(true);

    // predicate('child-id', 'sess-stranger') → 无共享 = false
    findSharedActiveTeamsSpy.mockReturnValue([]);
    expect(callArgs.predicate('child-id', 'sess-stranger')).toBe(false);
  });

  it('cascade 删多个 task → emit N 次 task-changed (root + 下游)', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1', 't2', 't3']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    expect(emitSpy).toHaveBeenCalledTimes(3);
    const calls = emitSpy.mock.calls;
    expect(calls[0][1]).toMatchObject({ kind: 'deleted', taskId: 't1' });
    expect(calls[1][1]).toMatchObject({ kind: 'deleted', taskId: 't2' });
    expect(calls[2][1]).toMatchObject({ kind: 'deleted', taskId: 't3' });
  });

  it('repo.delete 返回空数组（id 不存在或已删）时不 emit', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('callerSid null → isError', async () => {
    const tools = await buildToolsAsDict(repo, null);
    const result = await tools.task_delete.handler({ task_id: 't1' }, undefined);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
