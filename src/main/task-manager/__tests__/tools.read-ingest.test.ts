/**
 * Task Manager tools.ts 读操作 + ingest 单测（plan task-mcp-owner-session-id-rewrite-20260521 v023 重写）。
 *
 * 范围：task_list / task_get 行为 + sessionIdProvider → ingest team-task-* AgentEvent。
 *
 * v023 改：
 * - task_list 默认拉 caller 同 team active member 的所有 task（不再支持 args.team_id 跨 team 查）
 * - task_get 不限 team（按 task_id 直接 repo.get）
 * - ingest payload.teamName = caller 当前 first active team name（不再绑死 task.teamName）
 *
 * 不依赖 better-sqlite3 binding，也不依赖真 SDK（mock 与 tools.crud.test.ts 同款）。
 *
 * 工具集合形状 + 写工具行为（task_create / task_update / task_delete）在同目录
 * tools.crud.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@shared/types';
import type { TaskRepo } from '@main/store/task-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeEventBusMock } from '@main/__tests__/_shared/mocks/event-bus';

// ──────────────── module mocks ────────────────
vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock());

const emitSpy = vi.fn();
vi.mock('@main/event-bus', () => ({
  eventBus: makeEventBusMock({
    overrides: {
      emit: (...args: unknown[]) => emitSpy(...args),
    },
  }),
}));

const ingestSpy = vi.fn();
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    ingest: (...args: unknown[]) => ingestSpy(...args),
  },
  setSessionCloseFn: vi.fn(),
}));

const sessionGetSpy = vi.fn();
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sid: string) => sessionGetSpy(sid),
  },
}));

// team-repo: isCallerAuthorizedToWrite (findSharedActiveTeams) + visible scope helpers 全 spy
const findActiveMembershipsBySessionSpy = vi.fn();
const findActiveMembershipsBySessionIdsSpy = vi.fn();
const listActiveMembersSpy = vi.fn();
const findSharedActiveTeamsSpy = vi.fn();
const teamGetSpy = vi.fn(); // F2 deep-review Round 1:getVisibleOwnerSessionIds 二查 team archived
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    findActiveMembershipsBySession: (sid: string) => findActiveMembershipsBySessionSpy(sid),
    findActiveMembershipsBySessionIds: (sids: string[]) =>
      findActiveMembershipsBySessionIdsSpy(sids),
    listActiveMembers: (tid: string) => listActiveMembersSpy(tid),
    findSharedActiveTeams: (a: string, b: string) => findSharedActiveTeamsSpy(a, b),
    get: (tid: string) => teamGetSpy(tid),
  },
}));

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
  findActiveMembershipsBySessionSpy.mockReset();
  findActiveMembershipsBySessionIdsSpy.mockReset();
  listActiveMembersSpy.mockReset();
  findSharedActiveTeamsSpy.mockReset();
  teamGetSpy.mockReset();
  // 默认 caller session 存在(让 task_create FK 兜底通过)
  sessionGetSpy.mockReturnValue({ id: 'sess-caller' });
  // 默认 caller 无 team
  findActiveMembershipsBySessionSpy.mockReturnValue([]);
  findActiveMembershipsBySessionIdsSpy.mockReturnValue(new Map());
  // F2 默认:teamGet 返回 active team(archivedAt=null),让本来 active team 路径通过
  teamGetSpy.mockImplementation((tid: string) => ({ id: tid, archivedAt: null, name: tid }));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ──────────────── tests ────────────────
describe('task_list / visible scope (v023 §D6 reverse join)', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it('caller 无 team → ownerSessionIds = [callerSid]', async () => {
    findActiveMembershipsBySessionSpy.mockReturnValue([]);
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler({}, undefined);

    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSessionIds: ['sess-caller'] }),
    );
  });

  it('caller 在单 team → ownerSessionIds = caller + 同 team active members', async () => {
    findActiveMembershipsBySessionSpy.mockReturnValue([
      { teamId: 'team-1', teamName: 't1', sessionId: 'sess-caller', role: 'lead' },
    ]);
    listActiveMembersSpy.mockReturnValue([
      { sessionId: 'sess-caller' },
      { sessionId: 'sess-mate-A' },
      { sessionId: 'sess-mate-B' },
    ]);
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler({}, undefined);

    const callArgs = (repo.list as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      ownerSessionIds: string[];
    };
    expect(new Set(callArgs.ownerSessionIds)).toEqual(
      new Set(['sess-caller', 'sess-mate-A', 'sess-mate-B']),
    );
  });

  it('caller 在多 team → union 所有 team active members（去重）', async () => {
    findActiveMembershipsBySessionSpy.mockReturnValue([
      { teamId: 'team-1', teamName: 't1', sessionId: 'sess-caller', role: 'lead' },
      { teamId: 'team-2', teamName: 't2', sessionId: 'sess-caller', role: 'teammate' },
    ]);
    listActiveMembersSpy.mockImplementation((teamId: string) => {
      if (teamId === 'team-1') return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-A' }];
      if (teamId === 'team-2')
        return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-A' }, { sessionId: 'sess-B' }];
      return [];
    });
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler({}, undefined);

    const callArgs = (repo.list as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      ownerSessionIds: string[];
    };
    // sess-A 在两 team 都有 → 去重
    expect(new Set(callArgs.ownerSessionIds)).toEqual(
      new Set(['sess-caller', 'sess-A', 'sess-B']),
    );
  });

  it('F2 (deep-review Round 1 reviewer-codex MED-1):caller 在 archived team 的 ghost membership 不进 visible scope', async () => {
    // 修前:findActiveMembershipsBySession 只过滤 left_at IS NULL 不过滤 team archived,
    // caller 在 archived team 仍有 active membership → visible scope 包含该 team 所有
    // active session 的 task → task_list 看得到但 task_update / task_delete 走
    // isCallerAuthorizedToWrite → findSharedActiveTeams(强制 team archived 过滤)立即拒
    // → 「读得到但写不进」UX 矛盾。修后用 teamGet 二查过滤 archivedAt !== null 的 team。
    findActiveMembershipsBySessionSpy.mockReturnValue([
      { teamId: 'team-active', teamName: 't-active', sessionId: 'sess-caller', role: 'lead' },
      { teamId: 'team-archived', teamName: 't-archived', sessionId: 'sess-caller', role: 'lead' },
    ]);
    teamGetSpy.mockImplementation((tid: string) => {
      if (tid === 'team-active') return { id: tid, archivedAt: null, name: tid };
      if (tid === 'team-archived')
        return { id: tid, archivedAt: Date.now() - 1000, name: tid }; // archived
      return null;
    });
    listActiveMembersSpy.mockImplementation((teamId: string) => {
      if (teamId === 'team-active') return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-A' }];
      if (teamId === 'team-archived')
        return [{ sessionId: 'sess-caller' }, { sessionId: 'sess-archived-mate' }];
      return [];
    });
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler({}, undefined);

    const callArgs = (repo.list as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      ownerSessionIds: string[];
    };
    // 仅 active team 的 member 进 visible scope:caller + sess-A
    // archived team 的 sess-archived-mate **不**进 visible scope(F2 修法防御)
    expect(new Set(callArgs.ownerSessionIds)).toEqual(new Set(['sess-caller', 'sess-A']));
    expect(callArgs.ownerSessionIds).not.toContain('sess-archived-mate');
    // listActiveMembers 不应被 archived team 调到(短路前过滤)
    expect(listActiveMembersSpy).not.toHaveBeenCalledWith('team-archived');
  });

  it('F2: caller 所在 team row missing(DB 不一致 corner case) → 跳过该 team(与 archived 同款守门)', async () => {
    findActiveMembershipsBySessionSpy.mockReturnValue([
      { teamId: 'team-1', teamName: 't1', sessionId: 'sess-caller', role: 'lead' },
      { teamId: 'team-missing', teamName: 't?', sessionId: 'sess-caller', role: 'lead' },
    ]);
    teamGetSpy.mockImplementation((tid: string) => {
      if (tid === 'team-1') return { id: tid, archivedAt: null, name: tid };
      if (tid === 'team-missing') return null; // row missing
      return null;
    });
    listActiveMembersSpy.mockImplementation((teamId: string) =>
      teamId === 'team-1' ? [{ sessionId: 'sess-caller' }, { sessionId: 'sess-A' }] : [],
    );
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler({}, undefined);

    const callArgs = (repo.list as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      ownerSessionIds: string[];
    };
    expect(new Set(callArgs.ownerSessionIds)).toEqual(new Set(['sess-caller', 'sess-A']));
    expect(listActiveMembersSpy).not.toHaveBeenCalledWith('team-missing');
  });

  it('callerSid null → isError + 不调 repo.list', async () => {
    const tools = await buildToolsAsDict(repo, null);

    const result = await tools.task_list.handler({}, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('透传 status_filter / subject_filter / limit / offset 给 repo.list', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');

    await tools.task_list.handler(
      { status_filter: 'active', subject_filter: 'foo', limit: 50, offset: 10 },
      undefined,
    );

    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        subjectKeyword: 'foo',
        limit: 50,
        offset: 10,
      }),
    );
  });

  it('list 不 emit / 不 ingest（只读操作）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    await tools.task_list.handler({}, undefined);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('readOnlyHint annotation 已设', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    expect(tools.task_list.annotations?.readOnlyHint).toBe(true);
  });

  it('F4 (deep-review Round 1 reviewer-claude MED-c2):返回 { total, hasMore, tasks }', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    // 3 条 task,limit 默认 100 → hasMore=false
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      makeTask({ id: 't1' }),
      makeTask({ id: 't2' }),
      makeTask({ id: 't3' }),
    ]);
    const r1 = await tools.task_list.handler({}, undefined);
    const json1 = JSON.parse((r1.content[0] as { text: string }).text);
    expect(json1).toEqual(
      expect.objectContaining({ total: 3, hasMore: false }),
    );
    expect(json1.tasks).toHaveLength(3);
  });

  it('F4: tasks.length === effectiveLimit → hasMore=true(提示 caller 翻页)', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    // mock 返回 50 条恰好等于 limit=50 → hasMore=true(可能还有)
    const tasks50 = Array.from({ length: 50 }, (_, i) => makeTask({ id: `t-${i}` }));
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValueOnce(tasks50);
    const r = await tools.task_list.handler({ limit: 50 }, undefined);
    const json = JSON.parse((r.content[0] as { text: string }).text);
    expect(json).toEqual(
      expect.objectContaining({ total: 50, hasMore: true }),
    );
  });

  it('F4: tasks.length < effectiveLimit → hasMore=false(确认到底)', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const tasks5 = Array.from({ length: 5 }, (_, i) => makeTask({ id: `t-${i}` }));
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValueOnce(tasks5);
    const r = await tools.task_list.handler({ limit: 10 }, undefined);
    const json = JSON.parse((r.content[0] as { text: string }).text);
    expect(json).toEqual(
      expect.objectContaining({ total: 5, hasMore: false }),
    );
  });

  it('F4: tasks.length === 0 → hasMore=false', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    const r = await tools.task_list.handler({}, undefined);
    const json = JSON.parse((r.content[0] as { text: string }).text);
    expect(json).toEqual(
      expect.objectContaining({ total: 0, hasMore: false, tasks: [] }),
    );
  });
});

describe('task_get / 跨 team 读', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
  });

  it('返回 task 不限 owner / team（只读，跨 owner visibility）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const task = makeTask({ id: 't-other', ownerSessionId: 'sess-stranger' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(task);

    const result = await tools.task_get.handler({ task_id: 't-other' }, undefined);

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await tools.task_get.handler({ task_id: 'nope' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

/**
 * v023 改：ingest payload.teamName 从 task.teamName 改为「caller 当前 first active team name」。
 * 通过 agentDeckTeamRepo.findActiveMembershipsBySessionIds(单 sid) 取第一个 teamName，无 team
 * 时 null。这是 nice-to-have 展示信息（UI TeamDetail 用），不影响业务逻辑。
 *
 * 决策矩阵（与旧 v007 行为对齐）：
 * - task_create + caller 有 team → ingest 'team-task-created'，payload.teamName = first team
 * - task_create + caller 无 team → ingest 'team-task-created'，payload.teamName = null
 * - task_update status 变 completed + caller 有 team → ingest 'team-task-completed'
 * - task_update 改其他属性（priority/labels）→ 不 ingest（避免噪声）
 * - task_delete → 不 ingest（kind 集无 deleted 语义；强行复用 created 会混淆）
 */
describe('sessionIdProvider → ingest team-task-* AgentEvent', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
  });

  it('task_create + caller 有 team → ingest team-task-created (payload.teamName = first team)', async () => {
    findActiveMembershipsBySessionIdsSpy.mockReturnValue(
      new Map([['sess-caller', [{ teamId: 'team-1', teamName: 'team-A', role: 'lead' }]]]),
    );
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const created = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      subject: 'X',
      activeForm: 'agent-A',
    });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-caller',
        agentId: 'claude-code',
        source: 'sdk',
        kind: 'team-task-created',
        payload: expect.objectContaining({
          teamName: 'team-A',
          taskId: 't1',
          description: 'X',
          assignee: 'agent-A',
        }),
      }),
    );
  });

  it('task_create + caller 无 team → ingest 但 payload.teamName = null', async () => {
    findActiveMembershipsBySessionIdsSpy.mockReturnValue(new Map());
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ ownerSessionId: 'sess-caller' }),
    );

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ teamName: null }),
      }),
    );
  });

  it('task_update status pending → completed → ingest team-task-completed', async () => {
    findActiveMembershipsBySessionIdsSpy.mockReturnValue(
      new Map([['sess-caller', [{ teamId: 'team-1', teamName: 'team-A', role: 'lead' }]]]),
    );
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const before = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'pending',
      subject: 'work',
    });
    const after = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'completed',
      subject: 'work',
    });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-caller',
        agentId: 'claude-code',
        source: 'sdk',
        kind: 'team-task-completed',
        payload: expect.objectContaining({
          teamName: 'team-A',
          taskId: 't1',
          description: 'work',
        }),
      }),
    );
  });

  it('task_update status 已 completed → completed（不变）→ 不 ingest', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const before = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'completed',
    });
    const after = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'completed',
    });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task_update 改 priority（status 不变）→ 不 ingest', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const before = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'pending',
      priority: 5,
    });
    const after = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'pending',
      priority: 8,
    });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', priority: 8 }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('task_update status 变 active（不是 completed）→ 不 ingest', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    const before = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'pending',
    });
    const after = makeTask({
      id: 't1',
      ownerSessionId: 'sess-caller',
      status: 'active',
    });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task_delete → 不 ingest（kind 集无 deleted 语义）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ ownerSessionId: 'sess-caller' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('task_update 写权限拒（cross team）→ 不 ingest（早返）', async () => {
    const tools = await buildToolsAsDict(repo, 'sess-caller');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', ownerSessionId: 'sess-stranger' }),
    );
    findSharedActiveTeamsSpy.mockReturnValue([]);

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
