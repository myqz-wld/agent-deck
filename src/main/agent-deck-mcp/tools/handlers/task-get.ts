/**
 * task_get handler — 按 task_id 单条查询（跨 team 只读）。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式。
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_get = true（只读允许 external，read-only cross-team visibility）
 */

import { taskRepo } from '@main/store/task-repo';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskGetArgs, TaskGetResult } from '../schemas';

export const taskGetHandler = withMcpGuard(
  'task_get',
  async (args: TaskGetArgs, _ctx: HandlerContext) => {
    try {
      const t = taskRepo.get(args.task_id);
      if (!t) return err(`task ${args.task_id} not found`);
      return ok(t satisfies TaskGetResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
