/**
 * task_list handler — 列 caller 视角 visible task (caller-owned + 同 team active member 的 task).
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式。
 *
 * **D5**: schema 走 makeCtx，caller_session_id 从 ctx.caller.callerSessionId 拿
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_list = true（只读允许 external）
 *   external caller (sentinel)：getVisibleOwnerSessionIds 返 [sentinel] → 空结果是预期
 * **F2 修法**：getVisibleOwnerSessionIds 过滤 archived team（archived team 的 ghost membership 不进 visible scope）
 * **F4 修法**：返 { total, hasMore, tasks }，hasMore = tasks.length === effectiveLimit
 */

import { taskRepo } from '@main/store/task-repo';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskListArgs, TaskListResult } from '../schemas';
import { getVisibleOwnerSessionIds } from './task-helpers';

export const taskListHandler = withMcpGuard(
  'task_list',
  async (args: TaskListArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const visibleSids = getVisibleOwnerSessionIds(callerSid);
      const effectiveLimit = args.limit ?? 100;
      const tasks = taskRepo.list({
        status: args.status_filter,
        subjectKeyword: args.subject_filter,
        ownerSessionIds: visibleSids,
        limit: effectiveLimit,
        offset: args.offset,
      });
      // F4 修法 (deep-review Round 1 reviewer-claude MED-c2)：total 仅是当前页 task 数
      // (post-LIMIT/OFFSET 已截断的数组长度，不是真正 matching count)。加 hasMore hint
      // 让 caller 判断是否需要翻下一页 — 当 tasks.length === effectiveLimit 时为 true，
      // caller 应继续 task_list({offset: prevOffset + tasks.length})。完整 matching count
      // 不暴露（不另起 SELECT COUNT(*) 二次查询 — task 表通常规模 <几千 + 单用户场景）。
      return ok({
        total: tasks.length,
        hasMore: tasks.length === effectiveLimit,
        tasks,
      } satisfies TaskListResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
