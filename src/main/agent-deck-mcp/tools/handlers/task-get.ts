/**
 * task_get handler — 按 task_id 单条查询（v024 plan task-team-id-restore-20260525 §D8 严格 team-scoped read）。
 *
 * v024 plan §D8 修法（user 拍板方案 A flip false）— v023 cross-team 可读 use case 推翻:
 * - **EXTERNAL_CALLER_ALLOWED.task_get = false**(types.ts) — 与 task_create/update/delete 同款
 *   deny external 对称;external mcp client 走 withMcpGuard 入口 denyExternalIfNotAllowed 拦截
 *   返明确 error,**不再** silent reject
 * - **handler 加 isCallerAuthorizedToRead(callerSid, task) check**（D3 镜像 read 权限）:
 *   - team-bound task:caller 必须在 task.team_id 是 active member（双条件 §不变量 13）
 *   - personal task (team_id IS NULL):caller == owner 才能读（不开放同 team 共享）
 *
 * **v023 → v024 推翻 use case 明示**:
 * - in-process lead 跨 team 看 teammate task → 推翻（D3 严格 team-scoped 读）
 * - external mcp client 凭已知 task_id 查 task → 推翻（D8 flip false）
 */

import { taskRepo } from '@main/store/task-repo';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskGetArgs, TaskGetResult } from '../schemas';
import { isCallerAuthorizedToRead } from './task-helpers';

export const taskGetHandler = withMcpGuard(
  'task_get',
  async (args: TaskGetArgs, ctx: HandlerContext) => {
    try {
      const t = taskRepo.get(args.task_id);
      if (!t) return err(`task ${args.task_id} not found`);
      // v024 plan §D3 + D8 + Step C7:read 权限校验（与 write 对称）
      const callerSid = ctx.caller.callerSessionId;
      if (!isCallerAuthorizedToRead(callerSid, t)) {
        return err(
          `permission denied: caller "${callerSid}" cannot read task ${args.task_id} (team_id=${t.teamId ?? 'personal'}, owner=${t.ownerSessionId})`,
          'team-bound task 要求 caller 在该 team 是 active member（agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL 双条件,§不变量 13）;personal task 仅 owner 可读。',
        );
      }
      return ok(t satisfies TaskGetResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
