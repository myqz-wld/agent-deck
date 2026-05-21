/**
 * Task Manager 的 5 个 in-process MCP tools
 * (plan task-mcp-owner-session-id-rewrite-20260521 v023 重设计)。
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
 * 错误策略：所有 handler 内 try/catch 兜底；store 抛错（如 subject 空 / FK 错）→
 * 返回 isError: true，不让 throw 冒到 SDK 中断 agent loop。
 *
 * ─────────────────────────── v023 重设计（plan §D1-D6） ───────────────────────────
 *
 * **owner_session_id 闭包注入**（替代旧 teamIdProvider）：每个 handler 通过
 * `sessionIdProvider` 拿当前 SDK session id 当 task.owner_session_id。task 必有
 * owner，无 global task 概念。
 *
 * **team scope 推到 query 层**：tasks 表无 team 字段，team 关系由 sessions 表
 * + agent_deck_team_members 表 reverse join 算（owner_sid → sessions →
 * team_members.team_id → 同 team active member sids → 即 task 可见 caller 集合）。
 *
 * | 工具 | 权限策略 | 理由 |
 * |---|---|---|
 * | `task_create` | 强制 owner = caller_session_id（args 不暴露 owner） | task 必有 owner |
 * | `task_update` | caller 与 task owner 共享 active team（含 caller==owner 特例） | 同 team 都能写 |
 * | `task_delete` | 同 task_update | 同 task_update |
 * | `task_list`   | 默认拉 caller 同 team active member 的所有 task（含 caller 自己） | 协作可见性 |
 * | `task_get`    | 不限 team（按 task_id 直接查） | 读跨 team visibility 是协调必需 |
 *
 * **后置事件 emit**：写操作（create / update / delete）成功后通过 main 进程
 * `eventBus.emit('task-changed', ...)`，main bootstrap 桥接到 `IpcEvent.TaskChanged`
 * 推 renderer。当前 renderer 没 task UI 消费，但基础设施有了，未来 Tasks tab 直接订阅。
 */
import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { TaskCreateInput, TaskRepo } from '@main/store/task-repo';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
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
 * v023：把 zod 解析后的 args（snake_case + nullable | undefined）转成
 * TaskCreateInput 子集（camelCase，不含 ownerSessionId —— 那是 closure 强制注入）。
 * 仅放入「显式传了的字段」（!== undefined），让 repo 的 update 路径区分「不动」
 * 与「设为 null」。
 */
function argsToInputWithoutOwner(args: {
  subject?: string;
  description?: string | null;
  status?: (typeof STATUS_VALUES)[number];
  active_form?: string | null;
  priority?: number;
  blocks?: string[];
  blocked_by?: string[];
  labels?: string[];
}): Omit<Partial<TaskCreateInput>, 'ownerSessionId'> {
  const out: Omit<Partial<TaskCreateInput>, 'ownerSessionId'> = {};
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

/**
 * v023 plan §D6 + deep-review Round 1 F2 修法:算 caller 视角 visible owner session ids。
 *
 * 返回集合 = {callerSid} ∪ {caller 所在每个 **active** team 的所有 active member sids}。
 *
 * **F2 修法**(reviewer-codex MED-1):findActiveMembershipsBySession 只过滤 `left_at IS NULL`
 * 不过滤 team archived,与 findSharedActiveTeams(write 路径,member-query.ts:141-158 强制
 * `agent_deck_teams.archived_at IS NULL`)边界不一致 — 修前 caller 在 archived team 仍有
 * active membership 时,task_list visible scope 仍含 archived team 所有 session 的 task,
 * 但 task_update / task_delete 走 isCallerAuthorizedToWrite → findSharedActiveTeams 立即拒
 * (archived team 被过滤)→ 「读得到但写不进」UX 矛盾。修法:用 agentDeckTeamRepo.get(teamId)
 * 二查过滤 team archivedAt === null,只保留真正 active team。对 adopt 路径 Phase 7 reviewer-codex
 * Round 2 LOW + Round 3 polish 同款 archived team 过滤纪律对齐。
 *
 * 失败兜底:caller 无 active team membership(全在 archived team / 无 membership)→ 返
 * [callerSid](仅自己拥有的 task 可见;caller==owner 特例可写)。
 *
 * 复杂度:caller 在 N 个 team 时调 1 + 2N 次 SQL(findActiveMembershipsBySession + N × team.get +
 * N × listActiveMembers)。单用户场景 N ≤ 5 可接受。N 大时改单 SQL JOIN agent_deck_teams +
 * agent_deck_team_members 一次拿。
 */
function getVisibleOwnerSessionIds(callerSid: string): string[] {
  const teams = agentDeckTeamRepo.findActiveMembershipsBySession(callerSid);
  const sids = new Set<string>([callerSid]);
  for (const t of teams) {
    // F2 修法:二查 team row,过滤 archived team(member 行 active 但 team 已 archived
    // 的 ghost membership)。team row missing 也跳过(DB 不一致 corner case,FK 应拦)。
    const team = agentDeckTeamRepo.get(t.teamId);
    if (team === null || team.archivedAt !== null) continue;
    for (const m of agentDeckTeamRepo.listActiveMembers(t.teamId)) {
      sids.add(m.sessionId);
    }
  }
  return Array.from(sids);
}

/**
 * v023 plan §D2：写权限校验。caller 必须与 task owner 共享至少 1 个 active team
 * (含 caller == owner 特例 — 自己改自己 task)。跨 team / 无 shared team / 双方
 * archived → reject。
 *
 * 复用 agentDeckTeamRepo.findSharedActiveTeams（单 SQL JOIN，已 archive filter
 * archived team + 双方 archived session）。
 */
function isCallerAuthorizedToWrite(callerSid: string, ownerSid: string): boolean {
  if (callerSid === ownerSid) return true;
  return agentDeckTeamRepo.findSharedActiveTeams(callerSid, ownerSid).length > 0;
}

/**
 * 取 caller 第一个 active team name 当 ingest payload.teamName 字段（旧 v007 字段，
 * UI TeamDetail 用来显示「这条 task 在哪个 team」）。新 v023 schema task 不绑
 * team —— team 关系是 caller 视角推出来的，所以 ingest 时取 caller 当前 first
 * active team name 当 nice-to-have 展示信息。caller 无 team → null。
 *
 * 用 batch helper findActiveMembershipsBySessionIds (它 JOIN 了 agent_deck_teams
 * 拿 teamName)，单 sid 调 batch overhead 小（IN list 1 个，单 SQL）。
 */
function getCallerFirstTeamName(callerSid: string): string | null {
  const map = agentDeckTeamRepo.findActiveMembershipsBySessionIds([callerSid]);
  return map.get(callerSid)?.[0]?.teamName ?? null;
}

export async function buildTaskTools(
  repo: TaskRepo,
  /**
   * 必填：lazy 工厂返回当前 SDK session id（mcp-server-init.ts 传
   * `() => internal.applicationSid`）。task_create 闭包 owner_session_id，
   * task_list/update/delete 闭包 caller_session_id 做写权限校验 + visible scope。
   *
   * 返 null → handler 短路 err（提示 caller session 不可用，无法定位 owner /
   * caller）。typical 触发：tempKey 阶段（first realId 到达前）caller 提前调 task
   * tool；按设计极短窗口不该发生。
   */
  sessionIdProvider: () => string | null,
): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await loadSdk();
  const getCallerSid = (): string | null => sessionIdProvider();

  // ───── task_create
  const taskCreate = tool(
    'task_create',
    `Create a structured task in the agent-deck task store. The task is automatically owned by the current session (owner_session_id = caller_session_id). Visible to all sessions sharing any active team with the caller. Returns the created task with auto-generated id.`,
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
        const callerSid = getCallerSid();
        if (!callerSid) {
          return err('caller session id not available (tempKey window?) — cannot determine owner');
        }
        // v023 plan §不变量 1：task 必有真实 owner_session_id（FK → sessions(id)）。
        // 兜底 check sessionRepo 防 FK 错（虽然 SQLite throw 也会被 ok/err 兜，
        // 但提早返友好错误信息更利于 caller 诊断 tempKey timing 问题）。
        if (!sessionRepo.get(callerSid)) {
          return err(
            `caller session "${callerSid}" not in sessions table (tempKey window or session not yet committed) — retry after session is fully claimed`,
          );
        }
        const input: TaskCreateInput = {
          ...argsToInputWithoutOwner(args),
          ownerSessionId: callerSid,
          subject: args.subject ?? '',
        };
        const created = repo.create(input);
        eventBus.emit('task-changed', {
          kind: 'created',
          taskId: created.id,
          task: created,
          ownerSessionId: created.ownerSessionId,
          ts: Date.now(),
        });
        // 同步 ingest 一条 team-task-created AgentEvent 到 events 表，
        // 让 TeamDetail「hook 事件流」section 显示该动作。
        sessionManager.ingest({
          sessionId: callerSid,
          agentId: AGENT_ID,
          source: 'sdk',
          kind: 'team-task-created',
          ts: Date.now(),
          payload: {
            // v023：team 关系不再固化在 task；payload.teamName 取 caller 当前 first
            // active team name 当 UI 展示 hint（caller 无 team → null）。
            teamName: getCallerFirstTeamName(callerSid),
            taskId: created.id,
            description: created.subject,
            assignee: created.activeForm ?? null,
          },
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
    `List tasks visible to the current session: caller-owned tasks + tasks owned by any session sharing an active team with caller (archived teams excluded). Returns { total, hasMore, tasks: [...] } where total = tasks.length on current page (post-LIMIT/OFFSET) and hasMore signals more results may exist (tasks.length === limit). Default limit=100, max 500.`,
    {
      status_filter: z
        .enum(STATUS_VALUES)
        .optional()
        .describe('Only return tasks with this status'),
      subject_filter: z
        .string()
        .optional()
        .describe('Case-insensitive substring match on subject'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100, max 500'),
      offset: z.number().int().min(0).optional().describe('Default 0'),
    },
    async (args) => {
      try {
        const callerSid = getCallerSid();
        if (!callerSid) {
          return err('caller session id not available — cannot compute visible scope');
        }
        const visibleSids = getVisibleOwnerSessionIds(callerSid);
        const effectiveLimit = args.limit ?? 100;
        const tasks = repo.list({
          status: args.status_filter,
          subjectKeyword: args.subject_filter,
          ownerSessionIds: visibleSids,
          limit: effectiveLimit,
          offset: args.offset,
        });
        // F4 修法 (deep-review Round 1 reviewer-claude MED-c2):total 仅是当前页 task 数
        // (post-LIMIT/OFFSET 已截断的数组长度,不是真正 matching count)。加 hasMore hint
        // 让 caller 判断是否需要翻下一页 — 当 tasks.length === effectiveLimit 时为 true,
        // caller 应继续 task_list({offset: prevOffset + tasks.length})。完整 matching count
        // 不暴露(不另起 SELECT COUNT(*) 二次查询 — task 表通常规模 <几千 + 单用户场景)。
        return ok({
          total: tasks.length,
          hasMore: tasks.length === effectiveLimit,
          tasks,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ───── task_get
  const taskGet = tool(
    'task_get',
    'Get a single task by id. Returns the task regardless of team scope (read-only cross-team visibility).',
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
    `Incrementally update a task. Caller must share an active team with the task owner (or be the owner). Omitted fields are left unchanged. Pass null to clear nullable fields (description, active_form). updated_at is auto-refreshed.`,
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
        const callerSid = getCallerSid();
        if (!callerSid) return err('caller session id not available — cannot check write permission');
        const { task_id, ...rest } = args;
        const existing = repo.get(task_id);
        if (!existing) return err(`task ${task_id} not found`);
        // v023 plan §D2：写权限校验 — caller 与 owner 必须共享 active team（含
        // caller == owner 特例）。
        if (!isCallerAuthorizedToWrite(callerSid, existing.ownerSessionId)) {
          return err(
            `permission denied: task ${task_id} owner "${existing.ownerSessionId}" does not share any active team with caller "${callerSid}"`,
          );
        }
        // argsToInputWithoutOwner 已不放 ownerSessionId，patch 不会有 ownerSessionId 键
        const patch = argsToInputWithoutOwner(rest);
        const updated = repo.update(task_id, patch);
        if (!updated) return err(`task ${task_id} not found`);
        eventBus.emit('task-changed', {
          kind: 'updated',
          taskId: updated.id,
          task: updated,
          ownerSessionId: updated.ownerSessionId,
          ts: Date.now(),
        });
        // 仅当 status 变成 'completed' 时 ingest team-task-completed AgentEvent ——
        // 避免每次属性 update 都污染事件流。
        const becameCompleted =
          patch.status === 'completed' && existing.status !== 'completed';
        if (becameCompleted) {
          sessionManager.ingest({
            sessionId: callerSid,
            agentId: AGENT_ID,
            source: 'sdk',
            kind: 'team-task-completed',
            ts: Date.now(),
            payload: {
              // v023：caller 视角 first team name 当 UI hint；与 task_create 同款语义。
              teamName: getCallerFirstTeamName(callerSid),
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
    `Delete a task by id. Caller must share an active team with the task owner (or be the owner). With force=true, recursively delete all downstream tasks listed in blocks (each downstream is also write-permission-checked: cross-team children are skipped, not deleted). Without force, surviving tasks have their blocks/blocked_by references to it cleaned up.`,
    {
      task_id: z.string().describe('Task UUID to delete'),
      force: z
        .boolean()
        .optional()
        .describe('Default false; true = cascade delete blocks downstream chain'),
    },
    async (args) => {
      try {
        const callerSid = getCallerSid();
        if (!callerSid) return err('caller session id not available — cannot check write permission');
        const target = repo.get(args.task_id);
        if (!target) return err(`task ${args.task_id} not found`);
        // v023 plan §D2：写权限校验
        if (!isCallerAuthorizedToWrite(callerSid, target.ownerSessionId)) {
          return err(
            `permission denied: task ${args.task_id} owner "${target.ownerSessionId}" does not share any active team with caller "${callerSid}"`,
          );
        }
        // cascade=true 时 BFS 路径上每个 child 都要过写权限 — child owner 与 caller
        // 不共享 active team 时整个跳过（不删 + 不展开下游），避免越权。
        const deletedIds = repo.delete(args.task_id, {
          cascade: args.force ?? false,
          predicate: (_id, ownerSid) => isCallerAuthorizedToWrite(callerSid, ownerSid),
        });
        for (const id of deletedIds) {
          eventBus.emit('task-changed', {
            kind: 'deleted',
            taskId: id,
            task: null,
            ownerSessionId: target.ownerSessionId,
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
