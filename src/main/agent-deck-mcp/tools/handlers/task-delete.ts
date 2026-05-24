/**
 * task_delete handler — 删 task（含 cascade BFS 下游），caller 与 owner 必须共享 active team
 * （含 caller==owner 特例），cascade 路径上跨 team child 跳过避免越权。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式。
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_delete = false（write deny external）
 * **R2-codex-MED-1**: annotations.idempotentHint = false（与现状 contract 对齐 — not-found 返
 *   isError 不是 noop；保守不改 handler contract 不扩 scope）
 */

import { taskRepo } from '@main/store/task-repo';
import { eventBus } from '@main/event-bus';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskDeleteArgs, TaskDeleteResult } from '../schemas';
import { isCallerAuthorizedToWrite } from './task-helpers';

export const taskDeleteHandler = withMcpGuard(
  'task_delete',
  async (args: TaskDeleteArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const target = taskRepo.get(args.task_id);
      if (!target) return err(`task ${args.task_id} not found`);
      // v023 plan §D2：写权限校验
      if (!isCallerAuthorizedToWrite(callerSid, target.ownerSessionId)) {
        return err(
          `permission denied: task ${args.task_id} owner "${target.ownerSessionId}" does not share any active team with caller "${callerSid}"`,
        );
      }
      // cascade=true 时 BFS 路径上每个 child 都要过写权限 — child owner 与 caller
      // 不共享 active team 时整个跳过（不删 + 不展开下游），避免越权。
      // R3-codex-LOW-3 修法：predicate 变量名与 task-repo 接口对齐 `(_id, ownerSid)`。
      // R1-mixed-codex-LOW-D 修法（cascade emit owner mismatch）：删之前 snapshot
      // 每个 deleted id 的 ownerSessionId（cascade 路径上 same-team 其他 owner 的 child
      // 可能被删，emit 时按 child 自己 owner 而非 root target.ownerSessionId）。
      // TaskChangedEvent.ownerSessionId contract 明示 deleted 取自被删 task 原 owner
      // (src/shared/types/task.ts:53)，违反 contract 会让 future onTaskChanged consumer
      // 按 owner 过滤时漏刷新 child owner 视图。
      const ownerMap = new Map<string, string>();
      ownerMap.set(args.task_id, target.ownerSessionId);
      if (args.force) {
        // cascade=true 时 root.blocks 下游 task 可能被删 — pre-walk 收集每个潜在 child 的
        // owner。handler pre-walk **不应用 predicate**（unconditional walk 全 reachable child），
        // repo BFS **应用 predicate**（cross-team child 跳过 + 不展开下游），因此不变量
        // **ownerMap ⊇ deletedIds 严格成立** → fallback `?? target.ownerSessionId` 实际**永远
        // 不会触发**。保留 fallback 是 defensive coding 防 future repo BFS 改动（如加 blockedBy
        // 双向遍历）破坏不变量后让 emit throw — best-effort 退化为 root owner（emit 信息丢失
        // 但比 throw 好）。(R2-claude-LOW F-R2-2 注释精度修订)
        const queue = [...target.blocks];
        const visited = new Set<string>([args.task_id]);
        while (queue.length > 0) {
          const childId = queue.shift()!;
          if (visited.has(childId)) continue;
          visited.add(childId);
          const child = taskRepo.get(childId);
          if (!child) continue;
          ownerMap.set(childId, child.ownerSessionId);
          queue.push(...child.blocks);
        }
      }
      const deletedIds = taskRepo.delete(args.task_id, {
        cascade: args.force ?? false,
        predicate: (_id, ownerSid) => isCallerAuthorizedToWrite(callerSid, ownerSid),
      });
      for (const id of deletedIds) {
        eventBus.emit('task-changed', {
          kind: 'deleted',
          taskId: id,
          task: null,
          // ownerSessionId 取 child 自己 owner（详 L50-57 jsdoc：ownerMap 不变量 + fallback 性质）
          ownerSessionId: ownerMap.get(id) ?? target.ownerSessionId,
          ts: Date.now(),
        });
      }
      return ok({
        success: deletedIds.length > 0,
        task_id: args.task_id,
        deleted_ids: deletedIds,
      } satisfies TaskDeleteResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
