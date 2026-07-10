/**
 * task_delete handler — 删 task（含 cascade BFS 下游）。
 *
 * v024 plan task-team-id-restore-20260525 §D3 + Step C4 修法（HIGH-2 显式 callsite）:
 * - root check `isCallerAuthorizedToWrite(callerSid, target)` 传整个 task（按 teamId 判权限）
 * - cascade predicate `(_id, child) => isCallerAuthorizedToWrite(callerSid, child)` 传 child 完整 task
 *   （child 是 Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,详 task-repo.ts delete predicate signature）
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_delete = false（write deny external）
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
      const target = taskRepo.get(args.taskId);
      if (!target) {
        return err(
          `task ${args.taskId} not found`,
          'Call task_list with the appropriate teamIdFilter, or omit the filter for caller-visible scope, then retry with a returned task ID.',
        );
      }
      // v024 plan §D3 + Step C4:root check 传整个 task（按 teamId 判权限边界）
      if (!isCallerAuthorizedToWrite(callerSid, target)) {
        return err(
          `permission denied: caller "${callerSid}" cannot delete task ${args.taskId} (teamId=${target.teamId ?? 'personal'}, owner=${target.ownerSessionId})`,
          'Use an active member session for a team task or the owner session for a personal task. Call task_list to inspect tasks visible to this caller.',
        );
      }
      // cascade=true 时 BFS 路径上每个 child 都要过写权限 — child teamId 不允许 caller 写时
      // 整个跳过（不删 + 不展开下游），避免越权。**v024 Round 1 HIGH-2 修法**:predicate
      // 传 child 完整 task（不再传单 ownerSid）让 isCallerAuthorizedToWrite 按 child.teamId
      // 判权限边界。
      const ownerMap = new Map<string, string>();
      ownerMap.set(args.taskId, target.ownerSessionId);
      if (args.force) {
        // cascade=true 时 root.blocks 下游 task 可能被删 — pre-walk 收集每个潜在 child 的
        // owner（emit task-changed deleted ownerSessionId 用,§不变量 11 + R1 jsdoc 详）。
        // **REVIEW_87 LOW (reviewer-codex + reviewer-claude)**: pre-walk **必须复用 repo.delete
        // 同款 predicate** —— 越权 child（caller 无写权限）skip 且**不展开其下游**。修前 handler
        // pre-walk 不跑 predicate，对越权 child 仍 `queue.push(...child.blocks)` 读取并展开跨 team /
        // 他人 personal 子图（偏离「越权 child skip 不展开」防御边界 + ownerMap 收集了实际不会被删的
        // 节点）。与 task-repo-delete.ts:101-108 BFS predicate continue 语义对齐：predicate fail →
        // continue 不入队下游。这样 ownerMap 只含真正会被删的节点，emit deleted 事件 ownerSessionId
        // 精确（不再依赖 L下方 `?? target.ownerSessionId` 退化兜底）。
        const queue = [...target.blocks];
        const visited = new Set<string>([args.taskId]);
        while (queue.length > 0) {
          const childId = queue.shift()!;
          if (visited.has(childId)) continue;
          visited.add(childId);
          const child = taskRepo.get(childId);
          if (!child) continue;
          // 越权 child：skip + 不展开下游（与 repo.delete predicate 同款边界）。
          if (!isCallerAuthorizedToWrite(callerSid, child)) continue;
          ownerMap.set(childId, child.ownerSessionId);
          queue.push(...child.blocks);
        }
      }
      const deletedIds = taskRepo.delete(args.taskId, {
        cascade: args.force ?? false,
        // v024 Round 1 HIGH-2 修法:predicate 签名传 child 完整 task（Pick<TaskRecord,
        // 'ownerSessionId' | 'teamId'>）让 D3 按 child.teamId 判权限边界。
        predicate: (_id, child) => isCallerAuthorizedToWrite(callerSid, child),
      });
      for (const id of deletedIds) {
        eventBus.emit('task-changed', {
          kind: 'deleted',
          taskId: id,
          task: null,
          // ownerSessionId 取 child 自己 owner（详 ownerMap 不变量 + fallback 性质）
          ownerSessionId: ownerMap.get(id) ?? target.ownerSessionId,
          ts: Date.now(),
        });
      }
      return ok({
        success: deletedIds.length > 0,
        taskId: args.taskId,
        deletedIds: deletedIds,
      } satisfies TaskDeleteResult);
    } catch (e) {
      return err(
        e instanceof Error ? e.message : String(e),
        'If the error identifies invalid input, correct it. For a transient storage error, retry once; if it repeats, stop and inspect Agent Deck main-process logs.',
      );
    }
  },
);
