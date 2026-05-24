/**
 * task_update handler — 增量更新 task，caller 与 owner 必须共享 active team（含 caller==owner 特例）。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式。
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_update = false（write deny external）
 * **D7**: ingest 仅在 in-process transport（同 task_create 同款分流）
 */

import { sessionManager } from '@main/session/manager';
import { taskRepo } from '@main/store/task-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from '@main/adapters/claude-code/sdk-bridge/constants';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskUpdateArgs, TaskUpdateResult } from '../schemas';
import {
  argsToInputWithoutOwner,
  getCallerFirstTeamName,
  isCallerAuthorizedToWrite,
} from './task-helpers';

export const taskUpdateHandler = withMcpGuard(
  'task_update',
  async (args: TaskUpdateArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const { task_id, ...rest } = args;
      const existing = taskRepo.get(task_id);
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
      const updated = taskRepo.update(task_id, patch);
      if (!updated) return err(`task ${task_id} not found`);
      eventBus.emit('task-changed', {
        kind: 'updated',
        taskId: updated.id,
        task: updated,
        ownerSessionId: updated.ownerSessionId,
        ts: Date.now(),
      });
      // 仅当 status 变成 'completed' 时 ingest team-task-completed AgentEvent ——
      // 避免每次属性 update 都污染事件流。D7：仅 in-process transport ingest。
      const becameCompleted =
        patch.status === 'completed' && existing.status !== 'completed';
      if (becameCompleted && ctx.caller.transport === 'in-process') {
        sessionManager.ingest({
          sessionId: callerSid,
          agentId: AGENT_ID,
          source: 'sdk',
          kind: 'team-task-completed',
          ts: Date.now(),
          payload: {
            teamName: getCallerFirstTeamName(callerSid),
            taskId: updated.id,
            description: updated.subject,
          },
        });
      }
      return ok(updated satisfies TaskUpdateResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
