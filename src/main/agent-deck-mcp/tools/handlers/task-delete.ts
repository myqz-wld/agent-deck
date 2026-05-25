/**
 * task_delete handler — 删 task（含 cascade BFS 下游）。
 *
 * v024 plan task-team-id-restore-20260525 §D3 + Step C4 修法（HIGH-2 显式 callsite）:
 * - root check `isCallerAuthorizedToWrite(callerSid, target)` 传整个 task（按 team_id 判权限）
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
      const target = taskRepo.get(args.task_id);
      if (!target) return err(`task ${args.task_id} not found`);
      // v024 plan §D3 + Step C4:root check 传整个 task（按 team_id 判权限边界）
      if (!isCallerAuthorizedToWrite(callerSid, target)) {
        return err(
          `permission denied: caller "${callerSid}" cannot delete task ${args.task_id} (team_id=${target.teamId ?? 'personal'}, owner=${target.ownerSessionId})`,
          'team-bound task 要求 caller 在该 team 是 active member;personal task 仅 owner 可删。',
        );
      }
      // cascade=true 时 BFS 路径上每个 child 都要过写权限 — child team_id 不允许 caller 写时
      // 整个跳过（不删 + 不展开下游），避免越权。**v024 Round 1 HIGH-2 修法**:predicate
      // 传 child 完整 task（不再传单 ownerSid）让 isCallerAuthorizedToWrite 按 child.team_id
      // 判权限边界。
      const ownerMap = new Map<string, string>();
      ownerMap.set(args.task_id, target.ownerSessionId);
      if (args.force) {
        // cascade=true 时 root.blocks 下游 task 可能被删 — pre-walk 收集每个潜在 child 的
        // owner（emit task-changed deleted ownerSessionId 用,§不变量 11 + R1 jsdoc 详）。
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
        // v024 Round 1 HIGH-2 修法:predicate 签名传 child 完整 task（Pick<TaskRecord,
        // 'ownerSessionId' | 'teamId'>）让 D3 按 child.team_id 判权限边界。
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
        taskId: args.task_id,
        deletedIds: deletedIds,
      } satisfies TaskDeleteResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
