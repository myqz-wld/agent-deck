import { z } from 'zod';
import type { TaskRecord } from '@shared/types';
import { SDK_READ_CALLER_SESSION_ID_DESCRIPTION, SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';

/**
 * Task tool status 枚举（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 0.5 + R2 F-R2-4 修法）：
 * 放 schemas.ts 顶部 export 而非 handler/task-helpers.ts —— schema 层 enum 天然位置，
 * 避免 schema 层从 handler 层间接拉 sessionRepo / agentDeckTeamRepo 运行时依赖，
 * 破坏 schemas.ts 只依赖 zod 的纯 schema 边界。5 个 task tool schema + 5 handler 都从本处 import。
 *
 * 对齐 Claude Code CLI TaskCreate / TaskUpdate 状态字段语义。
 */
export const STATUS_VALUES = [
  'pending',
  'active',
  'completed',
  'blocked',
  'abandoned',
] as const;
export type TaskStatusValue = (typeof STATUS_VALUES)[number];

// =============== TASK_* (plan task-mcp-merge-into-agent-deck-mcp-20260521 合并 5 个 task tool) ===============
//
// 5 个 task tool schema：从原 src/main/task-manager/tools.ts 抽出，转 agent-deck-mcp 同款 SHAPE 模式。
//
// **D5 修法**：schema 加 callerSessionId?（与现有 10 个 simple tool 同款 — in-process closure
// override 优先于 args 字段）。task_create owner_session_id 不在 schema 暴露（closure 强制注入
// ctx.caller.callerSessionId）。
//
// 协议: callerSessionId 字段在 in-process / HTTP / stdio 三 transport 行为见 SPAWN_SESSION_SCHEMA
// 同字段注释。task 5 个 tool 同款语义。

export const TASK_CREATE_SCHEMA = {
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe('Short task title shown in task lists (1-200 chars).'),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional detailed description (max 2000 chars). Pass null or omit when not provided.'),
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'Initial status. Use pending, active, completed, blocked, or abandoned. Default is pending. Use active for in-progress work and completed for finished work.',
    ),
  activeForm: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Optional present-tense activity label shown in the Tasks UI, such as "Running tests".',
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Optional priority from 0 to 10. Default is 5.'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('Optional task UUIDs of downstream tasks that this task blocks.'),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe('Optional task UUIDs of upstream tasks that block this task.'),
  labels: z.array(z.string()).optional().describe('Optional free-form tags for filtering or grouping.'),
  // v024 plan task-team-id-restore-20260525 §D1+D2:teamId 字段
  teamId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Omit for a personal task visible only to the owner. Pass a team id for a team task visible and writable by active team members; the caller must be an active member.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_LIST_SCHEMA = {
  statusFilter: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'Only return tasks with this status: pending, active, completed, blocked, or abandoned.',
    ),
  subjectFilter: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring match on task subject.'),
  // v024 plan task-team-id-restore-20260525 §D5:teamIdFilter 三态 — FROZEN by Round 1 LOW-1
  // 用 zod literal `z.union([z.string().uuid(), z.literal('null-personal')])` 让 caller 显式表达。
  // 实际改用 z.union([z.string().min(1).max(128), z.literal('null-personal')]) 不强制 UUID 格式
  // (teamId 现实是 uuid 但 schema 层不绑死格式,与 task_create.teamId 字段一致).
  teamIdFilter: z
    .union([z.string().min(1).max(128), z.literal('null-personal')])
    .optional()
    .describe(
      "Optional task scope filter. Omit for all tasks visible to caller (caller-owned personal tasks plus team tasks from active memberships); pass a team id for that team's tasks (caller must be an active member); pass 'null-personal' for caller-owned personal tasks only.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum tasks to return. Default 100, max 500.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of matching tasks to skip before returning results. Default 0.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_READ_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_GET_SCHEMA = {
  taskId: z.string().describe('Task UUID returned by task_create.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_UPDATE_SCHEMA = {
  taskId: z.string().describe('Task UUID to update.'),
  subject: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional replacement task title (1-200 chars). Omit to leave unchanged.'),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional replacement description. Omit to leave unchanged; pass null to clear.'),
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'New status: pending, active, completed, blocked, or abandoned. Use active for in-progress work and completed for finished work.',
    ),
  activeForm: z
    .string()
    .nullable()
    .optional()
    .describe('Optional present-tense activity label. Omit to leave unchanged; pass null to clear.'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Optional replacement priority from 0 to 10. Omit to leave unchanged.'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('Task UUIDs that replace the whole blocks list. Omit to leave unchanged; pass [] to clear.'),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe('Task UUIDs that replace the whole blockedBy list. Omit to leave unchanged; pass [] to clear.'),
  labels: z
    .array(z.string())
    .optional()
    .describe('Labels that replace the whole labels list. Omit to leave unchanged; pass [] to clear.'),
  // v024 plan task-team-id-restore-20260525 §D1:允许 update 改 teamId(传 null 转 personal;
  // 传 string 转 team-bound)。caller 必须在新 teamId 是 active member(D3 由 tool 层校验)。
  teamId: z
    .string()
    .min(1)
    .max(128)
    .nullable()
    .optional()
    .describe(
      'Omit to leave unchanged. Pass a team id to make the task team-bound; the caller must be an active member. Pass null to make it personal to the caller.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_DELETE_SCHEMA = {
  taskId: z.string().describe('Task UUID to delete. Missing tasks return an MCP error.'),
  force: z
    .boolean()
    .optional()
    .describe('Default false. Pass true to recursively delete writable downstream tasks listed in blocks; non-writable downstream tasks are skipped.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// Args type infer（与现有 10 个 simple tool 同款 z.infer<z.ZodObject<typeof SCHEMA>>）
export type TaskCreateArgs = z.infer<z.ZodObject<typeof TASK_CREATE_SCHEMA>>;
export type TaskListArgs = z.infer<z.ZodObject<typeof TASK_LIST_SCHEMA>>;
export type TaskGetArgs = z.infer<z.ZodObject<typeof TASK_GET_SCHEMA>>;
export type TaskUpdateArgs = z.infer<z.ZodObject<typeof TASK_UPDATE_SCHEMA>>;
export type TaskDeleteArgs = z.infer<z.ZodObject<typeof TASK_DELETE_SCHEMA>>;

// Result types — handler return 用 `satisfies XxxResult` 校验

/** task_create ok return shape (handlers/task-create.ts)。 */
export type TaskCreateResult = TaskRecord;

/**
 * task_list ok return shape (handlers/task-list.ts)。
 *
 * F4 修法 (deep-review Round 1 reviewer-claude MED-c2)：total 仅是当前页 task 数
 * (post-LIMIT/OFFSET 已截断的数组长度)；hasMore = tasks.length === effectiveLimit
 * 提示 caller 是否需要翻下一页。完整 matching count 不暴露（不另起 SELECT COUNT(*)）。
 */
export interface TaskListResult {
  total: number;
  hasMore: boolean;
  tasks: TaskRecord[];
}

/** task_get ok return shape (handlers/task-get.ts)。 */
export type TaskGetResult = TaskRecord;

/** task_update ok return shape (handlers/task-update.ts)。 */
export type TaskUpdateResult = TaskRecord;

/**
 * task_delete ok return shape (handlers/task-delete.ts)。
 * - success: deletedIds.length > 0 即视为成功（cascade=false 至少删 target；cascade=true 含下游）
 * - taskId: 透传 args.taskId（root 删除目标）
 * - deletedIds: 实际被删的所有 task id（root + cascade 下游）
 */
export interface TaskDeleteResult {
  success: boolean;
  taskId: string;
  deletedIds: string[];
}
