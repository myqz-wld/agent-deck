/**
 * Task Manager tools.ts 写操作单测（CHANGELOG_43 — CHANGELOG_105 拆分自 tools.test.ts）。
 *
 * 范围：buildTaskTools 形状校验 + task_create / task_update / task_delete 三个写工具的
 * closure team_name 注入 + 跨 team 写防御 + emit task-changed 事件断言。
 *
 * 不依赖 better-sqlite3 binding，也不依赖真 SDK：
 * - mock `@main/adapters/claude-code/sdk-loader` 让 `tool()` 返回一个透明对象
 *   `{ name, description, inputSchema, handler }`，测试直接拿 handler 调
 * - mock `@main/event-bus` 让 emit 变成 vi.fn()，断言 emit 调用次数 / payload
 * - mock `TaskRepo` 用 vi.fn() 替全部方法，断言传给 repo 的参数正确（特别是
 *   closure 注入的 teamName）
 *
 * 不依赖 SQLite，所以本文件**任何 Node 版本都能跑**（不像 task-repo.test.ts 要 Node 20）。
 *
 * 覆盖点：
 * - closure team_name 注入：task_create / task_update / task_delete 只能写自己 team
 * - 写操作 emit task-changed 事件 + 正确的 kind / payload
 * - 错误返回 isError: true 而不是 throw
 *
 * task_list / task_get 跨 team 读 + A3 sessionIdProvider → ingest 在同目录
 * tools.read-ingest.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@shared/types';
import type { TaskRepo } from '@main/store/task-repo';

// ──────────────── module mocks ────────────────
// loadSdk: 返回一个 fake 的 tool 函数，签名同 SDK 真 tool()，return 透明 SdkMcpToolDefinition
// （annotations 字段对齐真 SDK 的 SdkMcpToolDefinition 形状：annotations 直接挂在
// 顶层，extras 不暴露）
vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: async () => ({
    tool: (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
      extras?: { annotations?: Record<string, unknown> },
    ) => ({
      name,
      description,
      inputSchema,
      handler,
      ...(extras?.annotations ? { annotations: extras.annotations } : {}),
    }),
  }),
}));

// event-bus: emit 变成 spy 函数
const emitSpy = vi.fn();
vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: (...args: unknown[]) => emitSpy(...args),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

// session/manager: ingest 变成 spy（CHANGELOG_<X> A3：tools.ts 写操作后调 ingest
// 写 team-task-* AgentEvent 到 events 表，让 TeamDetail 事件流也显示 mcp 操作）
const ingestSpy = vi.fn();
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    ingest: (...args: unknown[]) => ingestSpy(...args),
  },
  setSessionCloseFn: vi.fn(),
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
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'task-1',
    teamName: overrides.teamName ?? null,
    teamId: overrides.teamId ?? null,
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
 * 把 tools 数组转成按 name 索引的 dict，测试里写 tools.task_create.handler(...) 更顺。
 *
 * CHANGELOG_46：buildTaskTools 第二参数从 `string | null` 改 `() => string | null` lazy
 * provider。测试包一层把 fixed teamName 包成工厂，行为不变。
 *
 * CHANGELOG_<X> A3：buildTaskTools 第三参数 sessionIdProvider（optional）。默认测试不
 * 传 → tools 内 ingest 调用 sid=null 跳过（与 lead 还没建 team 窗口同语义）。需要测
 * ingest 的 case 用 buildToolsWithSession helper（下方）。
 */
async function buildToolsAsDict(repo: TaskRepo, teamName: string | null) {
  const arr = await buildTaskTools(repo, () => teamName);
  const dict: Record<string, (typeof arr)[number]> = {};
  for (const t of arr) dict[t.name] = t;
  return dict;
}

/** 加固定 sid 的 buildTools helper（A3 ingest 路径专用）。 */
async function buildToolsWithSession(
  repo: TaskRepo,
  teamName: string | null,
  sessionId: string | null,
) {
  const arr = await buildTaskTools(repo, () => teamName, () => sessionId);
  const dict: Record<string, (typeof arr)[number]> = {};
  for (const t of arr) dict[t.name] = t;
  return dict;
}

// ──────────────── tests ────────────────
describe('buildTaskTools / 工具集合形状', () => {
  beforeEach(() => emitSpy.mockReset());

  it('返回恰好 5 个工具，名字与 spec 一致', async () => {
    const tools = await buildTaskTools(makeMockRepo(), () => 'team-A');
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'task_create',
      'task_delete',
      'task_get',
      'task_list',
      'task_update',
    ]);
  });

  it('task_create / task_update / task_delete schema 不暴露 team_name 字段', async () => {
    const tools = await buildToolsAsDict(makeMockRepo(), 'team-A');
    expect(Object.keys(tools.task_create.inputSchema as object)).not.toContain('team_id');
    expect(Object.keys(tools.task_update.inputSchema as object)).not.toContain('team_id');
    expect(Object.keys(tools.task_delete.inputSchema as object)).not.toContain('team_id');
  });

  it('task_list schema 暴露 team_name（允许跨 team 只读）', async () => {
    const tools = await buildToolsAsDict(makeMockRepo(), 'team-A');
    expect(Object.keys(tools.task_list.inputSchema as object)).toContain('team_id');
  });

  it('REVIEW_17 R1 / M7：lazy provider 在多次调用之间返回不同值（CHANGELOG_46 改 lazy 的核心 gain）', async () => {
    const repo = makeMockRepo();
    let currentTeam: string | null = null;
    // provider 每次调返回最新值（模拟 team-coordinator 反向同步把 team_name 从 null 改成 team-A）
    const tools = await buildTaskTools(repo, () => currentTeam);
    const dict: Record<string, (typeof tools)[number]> = {};
    for (const t of tools) dict[t.name] = t;

    // 第 1 次调 task_create：provider 返回 null（lead 还没建 team）
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeTask({ id: 't-global', teamName: null, teamId: null }),
    );
    await dict.task_create.handler({ subject: 'X' }, undefined);
    expect(repo.create).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: null }));

    // team-coordinator 反向同步：currentTeam 切到 team-A
    currentTeam = 'team-A';

    // 第 2 次调 task_create：provider 返回 'team-A'（lazy 关键 gain）
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeTask({ id: 't-team-a', teamName: 'team-A', teamId: 'team-A' }),
    );
    await dict.task_create.handler({ subject: 'Y' }, undefined);
    expect(repo.create).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: 'team-A' }));
  });
});

describe('task_create', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    emitSpy.mockReset();
  });

  it('强制 closure 注入 teamName，调 repo.create 时 input.teamName 被覆盖', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    const created = makeTask({ id: 't1', subject: 'X', teamName: 'team-A', teamId: 'team-A' });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'X', teamId: 'team-A' }),
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('teamName=null 时走全局任务路径（input.teamName === null）', async () => {
    const tools = await buildToolsAsDict(repo, null);
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', teamName: null, teamId: null }),
    );

    await tools.task_create.handler({ subject: 'global task' }, undefined);

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ teamId: null }));
  });

  it('成功后 emit task-changed { kind: created, teamName 同 task.teamName }', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    const created = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A' });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({
        kind: 'created',
        taskId: 't1',
        task: created,
        teamName: 'team-A',
      }),
    );
  });

  it('repo.create 抛错时返回 isError + 不 emit', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('subject 不能为空');
    });

    const result = await tools.task_create.handler({ subject: 'X' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('task_update / 写权限锁', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    emitSpy.mockReset();
  });

  it('task.teamName === closure → 允许更新 + emit', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    const before = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'pending' });
    const after = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'completed' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    const result = await tools.task_update.handler(
      { task_id: 't1', status: 'completed' },
      undefined,
    );

    expect(repo.update).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'completed' }));
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'updated', task: after }),
    );
  });

  it('task.teamName !== closure → isError + 不调 repo.update + 不 emit', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', teamName: 'team-B', teamId: 'team-B' }),
    );

    const result = await tools.task_update.handler(
      { task_id: 't1', status: 'completed' },
      undefined,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('task.teamName=null vs closure="team-A" → isError（全局任务也不能被 team agent 改）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', teamName: null, teamId: null }),
    );

    const result = await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('closure=null 时只能改全局任务（task.teamName=null 通过、="team-A" 拒绝）', async () => {
    const tools = await buildToolsAsDict(repo, null);
    // case 1: 改全局任务 OK
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(makeTask({ teamName: null, teamId: null }));
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValueOnce(makeTask({ teamName: null, teamId: null }));
    let result = await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    // case 2: 改 team-A 任务被拒
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeTask({ teamName: 'team-A', teamId: 'team-A' }),
    );
    result = await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('task 不存在 → isError', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await tools.task_update.handler({ task_id: 'nope', status: 'active' }, undefined);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe('task_delete / 写权限锁', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    emitSpy.mockReset();
  });

  it('task.teamName === closure → 允许删 + emit', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A' }),
    );
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(repo.delete).toHaveBeenCalledWith('t1', expect.objectContaining({ cascade: false }));
    expect(emitSpy).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'deleted', taskId: 't1', teamName: 'team-A' }),
    );
  });

  it('force=true 透传 cascade=true', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    expect(repo.delete).toHaveBeenCalledWith('t1', expect.objectContaining({ cascade: true }));
  });

  it('REVIEW_17 H1：cascade 时给 repo.delete 传 closure team predicate（拦跨 team child）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    // 断言：传给 repo.delete 的 opts.predicate 真的是「闭包 team 才通过」
    const callArgs = (repo.delete as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      cascade: boolean;
      predicate: (id: string, name: string | null, id_: string | null) => boolean;
    };
    expect(typeof callArgs.predicate).toBe('function');
    // R3.E8：predicate 第 3 参数 teamId，闭包 = 'team-A'（teamId）
    expect(callArgs.predicate('any-id', null, 'team-A')).toBe(true);
    expect(callArgs.predicate('any-id', null, 'team-B')).toBe(false);
    expect(callArgs.predicate('any-id', null, null)).toBe(false);
  });

  it('REVIEW_17 H1：closure=null（全局会话）的 cascade predicate 仅放行 teamId=null', async () => {
    const tools = await buildToolsAsDict(repo, null);
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: null, teamId: null }));
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    const callArgs = (repo.delete as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      predicate: (id: string, name: string | null, id_: string | null) => boolean;
    };
    expect(callArgs.predicate('any-id', null, null)).toBe(true);
    expect(callArgs.predicate('any-id', null, 'team-A')).toBe(false);
  });

  it('REVIEW_17 R2 / M1-R2：cascade 删多个 task → emit N 次 task-changed (root + 下游)', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A' }));
    // mock repo.delete 返回 ['t1', 't2', 't3']：root + 2 个 cascade 下游
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1', 't2', 't3']);

    await tools.task_delete.handler({ task_id: 't1', force: true }, undefined);

    // 应该 emit 3 次 task-changed，每个 deletedId 一次
    expect(emitSpy).toHaveBeenCalledTimes(3);
    const calls = emitSpy.mock.calls;
    expect(calls[0][1]).toMatchObject({ kind: 'deleted', taskId: 't1' });
    expect(calls[1][1]).toMatchObject({ kind: 'deleted', taskId: 't2' });
    expect(calls[2][1]).toMatchObject({ kind: 'deleted', taskId: 't3' });
  });

  it('task.teamName !== closure → isError + 不调 repo.delete', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-B', teamId: 'team-B' }));

    const result = await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('repo.delete 返回 false（id 不存在或已删）时不 emit', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(emitSpy).not.toHaveBeenCalled();
  });
});

