/**
 * task_update handler — 增量更新 task（v024 plan task-team-id-restore-20260525 §D3 改造）。
 *
 * v024 plan §D3 + Step C4 修法（HIGH-2 + Round 6 MED-2 修法）:
 * - isCallerAuthorizedToWrite 改签名传整个 task（按 task.teamId 判权限边界,Round 1 HIGH-2）
 * - 团 teamId != null 时校验 caller 在该 team active member（双条件 §不变量 13）
 * - teamId IS NULL 时 caller == owner 才能写（personal task 不开放同 team 共享）
 * - teamId 改为 update 字段（patch.teamId 显式传 string 或 null;传时校验 caller 在新 team
 *   active member,从 team-bound 改 personal 不需校验）
 *
 * **ingest payload.teamName 改 v024 修法**(Round 1 MED-2 + Round 3 MED-3 +
 * Step C2 同款延续):取 updated.teamId lookup（不走 getCallerFirstTeamName）— 同 task-create 修法。
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_update = false（write deny external）
 * **D7**: ingest 仅在 in-process transport（同 task_create 同款分流）
 */

import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
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
  isCallerAuthorizedToWrite,
  isCallerInTeam,
} from './task-helpers';

export const taskUpdateHandler = withMcpGuard(
  'task_update',
  async (args: TaskUpdateArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const { taskId, ...rest } = args;
      const existing = taskRepo.get(taskId);
      if (!existing) return err(`task ${taskId} not found`);
      // v024 plan §D3 + Step C4:写权限校验 — 改签名传整个 task（按 task.teamId 判）。
      //（HIGH-2 修法,§不变量 12）
      if (!isCallerAuthorizedToWrite(callerSid, existing)) {
        return err(
          `permission denied: caller "${callerSid}" cannot write task ${taskId} (teamId=${existing.teamId ?? 'personal'}, owner=${existing.ownerSessionId})`,
          'team-bound task 要求 caller 在该 team 是 active member（agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL 双条件）;personal task 仅 owner 可写。Use task_create / task_get to verify your scope.',
        );
      }
      // v024 plan §D1 + Step C4:patch.teamId 显式传 string 时校验 caller 在新 team active member
      //（不论 args.teamId 是 update 改 team 还是初始 set,都要 caller 当前在该 team 才能放 task 进去）。
      // 显式传 null（改 personal）不需校验,任何 owner 都可把自己 task 转 personal。
      // undefined（不传）→ 不动 teamId,跳过校验。
      if (args.teamId !== undefined && args.teamId !== null) {
        if (!isCallerInTeam(callerSid, args.teamId)) {
          return err(
            `caller "${callerSid}" is not an active member of teamId "${args.teamId}" — task_update rejected (v024 plan §D3)`,
            'team-bound task 要求 caller 在该 team 是 active member。Use task_update with teamId=null to convert task to personal, or join the team first.',
          );
        }
      }
      // argsToInputWithoutOwner 已不放 ownerSessionId,patch 不会有 ownerSessionId 键。
      // v024:argsToInputWithoutOwner 已支持 args.teamId 透传到 patch.teamId。
      const patch = argsToInputWithoutOwner(rest);
      const updated = taskRepo.update(taskId, patch);
      if (!updated) return err(`task ${taskId} not found`);
      eventBus.emit('task-changed', {
        kind: 'updated',
        taskId: updated.id,
        task: updated,
        ownerSessionId: updated.ownerSessionId,
        ts: Date.now(),
      });
      // 仅当 status 变成 'completed' 时 ingest team-task-completed AgentEvent ——
      // 避免每次属性 update 都污染事件流。D7：仅 in-process transport ingest。
      // REVIEW_56 §F7 修法 (Plan-Review Round 1 + spike 决策): 加 `updated.status === 'completed'`
      // 第三条件防御 — 若 `taskRepo.update` 因 v024 teamId check 拒掉 status patch,
      // `patch.status='completed'` 但 `updated.status='pending'` 漂移时不应误触 becameCompleted。
      // CHANGELOG_165 修法: 加 `updated.teamId` 第四守卫,personal task (teamId IS NULL) skip
      // ingest — kind 名 `team-task-completed` 与 personal task 语义不符,且 v024 plan 把
      // personal task 升为 first-class default 后这条 event 在 ActivityFeed / TeamDetail
      // EventsSection 里全是噪声(用户 caller 跑自己 todo 与 team 无关却喷一条进事件流)。
      // eventBus.emit('task-changed') 不受影响仍发,UI TasksSection / task_list 实时性不丢。
      const becameCompleted =
        patch.status === 'completed' &&
        existing.status !== 'completed' &&
        updated.status === 'completed';
      if (becameCompleted && ctx.caller.transport === 'in-process' && updated.teamId) {
        // v024 Round 1 MED-2 修法:teamName 取 updated.teamId lookup（不走 getCallerFirstTeamName）
        const teamName = agentDeckTeamRepo.get(updated.teamId)?.name ?? null;
        sessionManager.ingest({
          sessionId: callerSid,
          agentId: AGENT_ID,
          source: 'sdk',
          kind: 'team-task-completed',
          ts: Date.now(),
          payload: {
            teamName,
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
