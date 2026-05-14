/**
 * Task Manager tools.ts 读操作 + A3 ingest 单测（CHANGELOG_43 — CHANGELOG_105 拆分自 tools.test.ts）。
 *
 * 范围：task_list / task_get 跨 team 读 + A3 sessionIdProvider → ingest team-task-* AgentEvent。
 *
 * 不依赖 better-sqlite3 binding，也不依赖真 SDK（mock 与 tools.crud.test.ts 同款）。
 *
 * 覆盖点：
 * - 跨 team 读：task_list 默认 closure / args 优先；task_get 不限 team
 * - A3 sessionIdProvider：写工具调 ingest 写 team-task-* AgentEvent 到 events 表
 *
 * 工具集合形状 + 写工具行为（task_create / task_update / task_delete）在同目录
 * tools.crud.test.ts。
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
describe('task_list / 跨 team 读', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    (repo.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
    emitSpy.mockReset();
  });

  it('args 不传 team_name → opts.teamName = closure', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    await tools.task_list.handler({}, undefined);
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-A' }));
  });

  it('args 显式传 string → opts.teamName = 该 string（跨 team 协调）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    await tools.task_list.handler({ team_id: 'team-B' }, undefined);
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-B' }));
  });

  it('args 显式传 null → opts.teamName = null（仅全局任务）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    await tools.task_list.handler({ team_id: null }, undefined);
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ teamId: null }));
  });

  it('closure=null（全局会话）默认查 opts.teamName = null', async () => {
    const tools = await buildToolsAsDict(repo, null);
    await tools.task_list.handler({}, undefined);
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ teamId: null }));
  });

  it('list 不 emit（只读操作）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    await tools.task_list.handler({}, undefined);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('readOnlyHint annotation 已设', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    expect(tools.task_list.annotations?.readOnlyHint).toBe(true);
  });
});

describe('task_get / 跨 team 读', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    emitSpy.mockReset();
  });

  it('返回 task 不限 team（只读，跨 team visibility）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    const task = makeTask({ id: 't-other', teamName: 'team-B', teamId: 'team-B' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(task);

    const result = await tools.task_get.handler({ task_id: 't-other' }, undefined);

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('task 不存在 → isError', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await tools.task_get.handler({ task_id: 'nope' }, undefined);

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

/**
 * CHANGELOG_<X> A3：sessionIdProvider 注入 → 写操作后 ingest team-task-* AgentEvent
 * 到 events 表，让 TeamDetail「hook 事件流」section 也能显示 mcp 操作。
 *
 * 决策矩阵：
 * - task_create + sid 非空 → ingest 'team-task-created' 一次
 * - task_update status 变 completed + sid 非空 → ingest 'team-task-completed' 一次
 * - task_update 改其他属性（priority/labels）→ 不 ingest（避免 noise 污染事件流）
 * - task_delete → 不 ingest（kind 集没 deleted 语义；强行复用 created 会混淆）
 * - sid=null（lead 还没建 team / 测试场景）→ 任何写操作都不 ingest（不抛错）
 */
describe('A3 sessionIdProvider → ingest team-task-* AgentEvent', () => {
  let repo: TaskRepo;
  beforeEach(() => {
    repo = makeMockRepo();
    emitSpy.mockReset();
    ingestSpy.mockReset();
  });

  it('task_create + sid → ingest team-task-created 一次', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    const created = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', subject: 'X', activeForm: 'agent-A' });
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(created);

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-X',
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

  it('task_create + sid=null → 不 ingest（不抛错）', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', null);
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('task_create 不传 sessionIdProvider → 不 ingest（向后兼容）', async () => {
    const tools = await buildToolsAsDict(repo, 'team-A');
    (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));

    await tools.task_create.handler({ subject: 'X' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task_update status pending → completed → ingest team-task-completed 一次', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    const before = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'pending', subject: 'work' });
    const after = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'completed', subject: 'work' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-X',
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
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    const before = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'completed' });
    const after = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'completed' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task_update 改 priority（status 不变）→ 不 ingest', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    const before = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'pending', priority: 5 });
    const after = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'pending', priority: 8 });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', priority: 8 }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('task_update status 变 active（不是 completed）→ 不 ingest', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    const before = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'pending' });
    const after = makeTask({ id: 't1', teamName: 'team-A', teamId: 'team-A', status: 'active' });
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(before);
    (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(after);

    await tools.task_update.handler({ task_id: 't1', status: 'active' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('task_delete → 不 ingest（kind 集无 deleted 语义）', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(makeTask({ teamName: 'team-A', teamId: 'team-A' }));
    (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(['t1']);

    await tools.task_delete.handler({ task_id: 't1' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1); // task-changed 仍发
  });

  it('task_update 写权限拒（跨 team）→ 不 ingest（早返）', async () => {
    const tools = await buildToolsWithSession(repo, 'team-A', 'sess-X');
    (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(
      makeTask({ id: 't1', teamName: 'team-B', teamId: 'team-B' }),
    );

    await tools.task_update.handler({ task_id: 't1', status: 'completed' }, undefined);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
