/**
 * Task Manager 的 5 个 in-process MCP tools（CHANGELOG_42 地基 + CHANGELOG_43 + R3.E8 teamId 迁移）。
 *
 * 通过 `loadSdk()` 异步加载 SDK 才能拿到 `tool` / `createSdkMcpServer`：SDK 是
 * ESM-only，agent-deck 全栈用 [sdk-loader.ts](../adapters/claude-code/sdk-loader.ts)
 * 的 `new Function('s', 'return import(s)')` 绕开 Vite 静态分析陷阱。
 *
 * Zod 是 SDK 的 peer dep（^4.0.0），CJS/ESM 都支持，可直接顶层 import。
 *
 * 字段命名约定：tool args 用 snake_case（与 spec / Python SDK / Claude Code CLI
 * TaskCreate 字段一致，方便 Claude 看到熟悉的 schema），repo / TaskRecord 用
 * camelCase（agent-deck TS 内部惯例）。两者在 handler 里手工映射。
 *
 * 错误策略：所有 handler 内 try/catch 兜底；store 抛错（如 subject 空）→ 返回
 * isError: true，不让 throw 冒到 SDK 中断 agent loop。
 *
 * ─────────────────────────── R3.E8 升级 ───────────────────────────
 *
 * **Closure team_id 注入**（替代 CHANGELOG_43 的 teamName 闭包）：每个 handler 通过
 * `teamIdProvider`（lazy lookup `agent_deck_team_members` 反查 caller 当前所属 team；
 * 多 team 时取最近 join + lead role 优先）拿当前 SDK session 的 team_id。
 *
 * | 工具 | team_id 来源 | 理由 |
 * |---|---|---|
 * | `task_create` | 强制 closure（args 不暴露 team_id） | 写锁在自己 team |
 * | `task_update` | 强制 closure（先校验 target.teamId === closure 才允许改） | 写锁；防跨 team 改 |
 * | `task_delete` | 强制 closure（先校验 target.teamId === closure 才允许删） | 写锁；防跨 team 删 |
 * | `task_list`   | args 优先 / 不传时 = closure team；显式传 null = 全局任务 | 只读，允许 lead 跨 team 协调 |
 * | `task_get`    | 不限 team（按 task_id 直接查，返回带 teamId） | 只读，跨 team visibility 是协调必需 |
 *
 * 老 tasks.team_name 列继续保留只读历史；新代码不写 team_name。
 *
 * **后置事件 emit**：写操作（create / update / delete）成功后通过 main 进程
 * `eventBus.emit('task-changed', ...)`，main bootstrap 桥接到 `IpcEvent.TaskChanged`
 * 推 renderer。当前 renderer 没 task UI 消费，但基础设施有了，未来 Tasks tab 直接订阅。
 */
import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { TaskCreateInput, TaskListOptions, TaskRepo } from '@main/store/task-repo';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { AGENT_ID } from '@main/adapters/claude-code/sdk-bridge/constants';

const STATUS_VALUES = ['pending', 'active', 'completed', 'blocked', 'abandoned'] as const;

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * 把 zod 解析后的 args（snake_case + nullable | undefined）转成 TaskCreateInput
 * 子集（camelCase，不含 teamId / teamName —— 那是 closure 强制的）。仅放入「显式传了的字段」
 * （!== undefined），让 repo 的 update 路径区分「不动」与「设为 null」。
 */
function argsToInputWithoutTeam(args: {
  subject?: string;
  description?: string | null;
  status?: (typeof STATUS_VALUES)[number];
  active_form?: string | null;
  priority?: number;
  blocks?: string[];
  blocked_by?: string[];
  labels?: string[];
}): Omit<Partial<TaskCreateInput>, 'teamName' | 'teamId'> {
  const out: Omit<Partial<TaskCreateInput>, 'teamName' | 'teamId'> = {};
  if (args.subject !== undefined) out.subject = args.subject;
  if (args.description !== undefined) out.description = args.description;
  if (args.status !== undefined) out.status = args.status;
  if (args.active_form !== undefined) out.activeForm = args.active_form;
  if (args.priority !== undefined) out.priority = args.priority;
  if (args.blocks !== undefined) out.blocks = args.blocks;
  if (args.blocked_by !== undefined) out.blockedBy = args.blocked_by;
  if (args.labels !== undefined) out.labels = args.labels;
  return out;
}

export async function buildTaskTools(
  repo: TaskRepo,
  teamIdProvider: () => string | null,
  /**
   * lazy 工厂返回当前 SDK session id（CHANGELOG_<X> A3）。每次工具调用时调一次拿最新值。
   *
   * 用途：写操作（create / update→completed）成功后调 sessionManager.ingest 写一条
   * `team-task-created / team-task-completed` AgentEvent（source='sdk'）到 events 表，
   * 让 TeamDetail「hook 事件流」section 也能显示 mcp task 操作。
   *
   * sid 为 null 时跳过 ingest（不抛错）。
   */
  sessionIdProvider?: () => string | null,
): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await loadSdk();
  // R3.E8：team_id lazy provider，每次工具调用时调一次拿最新值。
  const getTeamId = (): string | null => teamIdProvider();
  const getSessionId = (): string | null =>
    sessionIdProvider ? sessionIdProvider() : null;

  // ───── task_create
  const taskCreate = tool(
    'task_create',
    `Create a structured task in the agent-deck task store. The task is automatically scoped to the current session's team (use task_get / task_list to inspect actual scope); you cannot create tasks in another team. Returns the created task with auto-generated id.`,
    {
      subject: z.string().min(1).max(200).describe('Short task title (1-200 chars)'),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe('Detailed description (≤2000 chars)'),
      status: z
        .enum(STATUS_VALUES)
        .optional()
        .describe('Initial status (default "pending")'),
      active_form: z
        .string()
        .nullable()
        .optional()
        .describe('Name of the agent currently working on / claiming this task'),
      priority: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Priority 0-10 (default 5)'),
      blocks: z
        .array(z.string())
        .optional()
        .describe('IDs of downstream tasks that this task blocks'),
      blocked_by: z
        .array(z.string())
        .optional()
        .describe('IDs of upstream tasks that block this task'),
      labels: z.array(z.string()).optional().describe('Free-form tags'),
    },
    async (args) => {
      try {
        const input = {
          ...argsToInputWithoutTeam(args),
          teamId: getTeamId(),
        } as TaskCreateInput;
        const created = repo.create(input);
        eventBus.emit('task-changed', {
          kind: 'created',
          taskId: created.id,
          task: created,
          teamId: created.teamId,
          teamName: created.teamName,
          ts: Date.now(),
        });
        // CHANGELOG_<X> A3：同步 ingest 一条 team-task-created AgentEvent 到 events 表，
        // 让 TeamDetail「hook 事件流」section 显示该动作。sid=null 跳过。
        const sid = getSessionId();
        if (sid) {
          sessionManager.ingest({
            sessionId: sid,
            agentId: AGENT_ID,
            source: 'sdk',
            kind: 'team-task-created',
            ts: Date.now(),
            payload: {
              teamName: created.teamName,
              taskId: created.id,
              description: created.subject,
              assignee: created.activeForm ?? null,
            },
          });
        }
        return ok(created);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ───── task_list
  const taskList = tool(
    'task_list',
    `List tasks. Defaults to current session's team. Pass team_id explicitly to override: a string queries that team_id; null queries only global tasks (team_id IS NULL). Returns { total, tasks: [...] }.`,
    {
      status_filter: z
        .enum(STATUS_VALUES)
        .optional()
        .describe('Only return tasks with this status'),
      subject_filter: z
        .string()
        .optional()
        .describe('Case-insensitive substring match on subject'),
      team_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          `Override team scope. Omit = current session's team_id; null = only global; string = that team_id`,
        ),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100, max 500'),
      offset: z.number().int().min(0).optional().describe('Default 0'),
    },
    async (args) => {
      try {
        const opts: TaskListOptions = {};
        if (args.status_filter !== undefined) opts.status = args.status_filter;
        if (args.subject_filter !== undefined) opts.subjectKeyword = args.subject_filter;
        // R3.E8：args.team_id 优先；没传时用 closure team_id。这是只读操作允许跨查的核心点。
        opts.teamId = args.team_id !== undefined ? args.team_id : getTeamId();
        if (args.limit !== undefined) opts.limit = args.limit;
        if (args.offset !== undefined) opts.offset = args.offset;
        const tasks = repo.list(opts);
        return ok({ total: tasks.length, tasks });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ───── task_get
  const taskGet = tool(
    'task_get',
    'Get a single task by id. Returns the task regardless of team (read-only cross-team visibility).',
    {
      task_id: z.string().describe('Task UUID returned by task_create'),
    },
    async (args) => {
      try {
        const t = repo.get(args.task_id);
        if (!t) return err(`task ${args.task_id} not found`);
        return ok(t);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ───── task_update
  const taskUpdate = tool(
    'task_update',
    `Incrementally update a task. The task must belong to the current session's team; attempting to update another team's task returns an error. Omitted fields are left unchanged. Pass null to clear nullable fields (description, active_form). updated_at is auto-refreshed.`,
    {
      task_id: z.string().describe('Task UUID to update'),
      subject: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
      status: z.enum(STATUS_VALUES).optional(),
      active_form: z.string().nullable().optional(),
      priority: z.number().int().min(0).max(10).optional(),
      blocks: z.array(z.string()).optional(),
      blocked_by: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const { task_id, ...rest } = args;
        const existing = repo.get(task_id);
        if (!existing) return err(`task ${task_id} not found`);
        const currentTeam = getTeamId();
        // R3.E8 写权限锁：只能改自己 team_id 的任务
        if (existing.teamId !== currentTeam) {
          return err(
            `permission denied: task ${task_id} belongs to team_id "${existing.teamId ?? '<global>'}", current session is in team_id "${currentTeam ?? '<global>'}"`,
          );
        }
        // argsToInputWithoutTeam 已不放 teamId / teamName，patch 不会有 teamId 键
        const patch = argsToInputWithoutTeam(rest);
        const updated = repo.update(task_id, patch);
        if (!updated) return err(`task ${task_id} not found`);
        eventBus.emit('task-changed', {
          kind: 'updated',
          taskId: updated.id,
          task: updated,
          teamId: updated.teamId,
          teamName: updated.teamName,
          ts: Date.now(),
        });
        // CHANGELOG_<X> A3：仅当 status 变成 'completed' 时 ingest team-task-completed
        // AgentEvent —— 避免每次属性 update 都污染事件流。
        const becameCompleted =
          patch.status === 'completed' && existing.status !== 'completed';
        const sid = getSessionId();
        if (sid && becameCompleted) {
          sessionManager.ingest({
            sessionId: sid,
            agentId: AGENT_ID,
            source: 'sdk',
            kind: 'team-task-completed',
            ts: Date.now(),
            payload: {
              teamName: updated.teamName,
              taskId: updated.id,
              description: updated.subject,
            },
          });
        }
        return ok(updated);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ───── task_delete
  const taskDelete = tool(
    'task_delete',
    `Delete a task by id. The task must belong to the current session's team. With force=true, recursively delete all downstream tasks listed in blocks (each downstream is also team-checked: cross-team children are skipped, not deleted). Without force, surviving tasks have their blocks/blocked_by references to it cleaned up.`,
    {
      task_id: z.string().describe('Task UUID to delete'),
      force: z
        .boolean()
        .optional()
        .describe('Default false; true = cascade delete blocks downstream chain'),
    },
    async (args) => {
      try {
        const target = repo.get(args.task_id);
        if (!target) return err(`task ${args.task_id} not found`);
        const currentTeam = getTeamId();
        // R3.E8 写权限锁：只能删自己 team_id 的任务
        if (target.teamId !== currentTeam) {
          return err(
            `permission denied: task ${args.task_id} belongs to team_id "${target.teamId ?? '<global>'}", current session is in team_id "${currentTeam ?? '<global>'}"`,
          );
        }
        // R3.E8：cascade=true 时把 closure team_id predicate 传进 repo.delete。
        // BFS 路径上跨 team 的 child 整个跳过（不删 + 不展开它的下游），避免越权。
        const deletedIds = repo.delete(args.task_id, {
          cascade: args.force ?? false,
          predicate: (_, _teamName, teamId) => teamId === currentTeam,
        });
        for (const id of deletedIds) {
          eventBus.emit('task-changed', {
            kind: 'deleted',
            taskId: id,
            task: null,
            teamId: target.teamId,
            teamName: target.teamName,
            ts: Date.now(),
          });
        }
        return ok({ success: deletedIds.length > 0, task_id: args.task_id, deleted_ids: deletedIds });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return [taskCreate, taskList, taskGet, taskUpdate, taskDelete];
}
