/**
 * Task Manager 的 5 个 in-process MCP tools（CHANGELOG_42 地基 + CHANGELOG_43 升级）。
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
 * ─────────────────────────── CHANGELOG_43 升级 ───────────────────────────
 *
 * **Closure team_name 注入**：`buildTaskTools(repo, teamName)` 的 `teamName` 闭包
 * 进每个 handler。语义按工具角色拆开：
 *
 * | 工具 | team_name 来源 | 理由 |
 * |---|---|---|
 * | `task_create` | 强制 closure（args 不暴露 team_name） | 写锁在自己 team |
 * | `task_update` | 强制 closure（args 不暴露；先校验 target.teamName === closure 才允许改） | 写锁；防跨 team 改 |
 * | `task_delete` | 强制 closure（先校验 target.teamName === closure 才允许删） | 写锁；防跨 team 删 |
 * | `task_list`   | args 优先 / 不传时 = closure team；显式传 null = 全局任务 | 只读，允许 lead 跨 team 协调 |
 * | `task_get`    | 不限 team（按 task_id 直接查，返回带 teamName） | 只读，跨 team visibility 是协调必需 |
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
 * 子集（camelCase，不含 teamName —— 那是 closure 强制的）。仅放入「显式传了的字段」
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
}): Omit<Partial<TaskCreateInput>, 'teamName'> {
  const out: Omit<Partial<TaskCreateInput>, 'teamName'> = {};
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
  teamName: string | null,
): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await loadSdk();
  const teamLabel = teamName ?? '<global>';

  // ───── task_create
  const taskCreate = tool(
    'task_create',
    `Create a structured task in the agent-deck task store. The task is automatically scoped to the current session's team (${teamLabel}); you cannot create tasks in another team. Returns the created task with auto-generated id.`,
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
          teamName,
        } as TaskCreateInput;
        const created = repo.create(input);
        eventBus.emit('task-changed', {
          kind: 'created',
          taskId: created.id,
          task: created,
          teamName: created.teamName,
          ts: Date.now(),
        });
        return ok(created);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ───── task_list
  const taskList = tool(
    'task_list',
    `List tasks. Defaults to current team (${teamLabel}). Pass team_name explicitly to override: a string queries that team; null queries only global tasks (team_name IS NULL). Returns { total, tasks: [...] }.`,
    {
      status_filter: z
        .enum(STATUS_VALUES)
        .optional()
        .describe('Only return tasks with this status'),
      subject_filter: z
        .string()
        .optional()
        .describe('Case-insensitive substring match on subject'),
      team_name: z
        .string()
        .nullable()
        .optional()
        .describe(
          `Override team scope. Omit = current team (${teamLabel}); null = only global; string = that team`,
        ),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100, max 500'),
      offset: z.number().int().min(0).optional().describe('Default 0'),
    },
    async (args) => {
      try {
        const opts: TaskListOptions = {};
        if (args.status_filter !== undefined) opts.status = args.status_filter;
        if (args.subject_filter !== undefined) opts.subjectKeyword = args.subject_filter;
        // args 优先；没传时用 closure team。这是只读操作允许跨查的核心点。
        opts.teamName = args.team_name !== undefined ? args.team_name : teamName;
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
    `Incrementally update a task. The task must belong to the current team (${teamLabel}); attempting to update another team's task returns an error. Omitted fields are left unchanged. Pass null to clear nullable fields (description, active_form). updated_at is auto-refreshed.`,
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
        // 写权限锁：只能改自己 team 的任务（含全局任务的 agent 改全局任务）
        if (existing.teamName !== teamName) {
          return err(
            `permission denied: task ${task_id} belongs to team "${existing.teamName ?? '<global>'}", current session is in "${teamLabel}"`,
          );
        }
        // 强制覆盖 teamName（防 patch 路径绕过 closure 锁；理论上 args 已经不暴露
        // team_name，但 argsToInputWithoutTeam 也明确不放入，这里 patch 不会有 teamName 键）
        const patch = argsToInputWithoutTeam(rest);
        const updated = repo.update(task_id, patch);
        if (!updated) return err(`task ${task_id} not found`);
        eventBus.emit('task-changed', {
          kind: 'updated',
          taskId: updated.id,
          task: updated,
          teamName: updated.teamName,
          ts: Date.now(),
        });
        return ok(updated);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ───── task_delete
  const taskDelete = tool(
    'task_delete',
    `Delete a task by id. The task must belong to the current team (${teamLabel}). With force=true, recursively delete all downstream tasks listed in blocks (each downstream is also team-checked). Without force, surviving tasks have their blocks/blocked_by references to it cleaned up.`,
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
        // 写权限锁：只能删自己 team 的任务
        if (target.teamName !== teamName) {
          return err(
            `permission denied: task ${args.task_id} belongs to team "${target.teamName ?? '<global>'}", current session is in "${teamLabel}"`,
          );
        }
        const success = repo.delete(args.task_id, { cascade: args.force ?? false });
        if (success) {
          eventBus.emit('task-changed', {
            kind: 'deleted',
            taskId: args.task_id,
            task: null,
            teamName: target.teamName,
            ts: Date.now(),
          });
        }
        return ok({ success, task_id: args.task_id });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return [taskCreate, taskList, taskGet, taskUpdate, taskDelete];
}
