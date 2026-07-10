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
      if (!existing) {
        return err(
          `task ${taskId} not found`,
          'Call task_list with the appropriate teamIdFilter, or omit the filter for caller-visible scope, then retry with a returned task ID.',
        );
      }
      // v024 plan §D3 + Step C4:写权限校验 — 改签名传整个 task（按 task.teamId 判）。
      //（HIGH-2 修法,§不变量 12）
      if (!isCallerAuthorizedToWrite(callerSid, existing)) {
        return err(
          `permission denied: caller "${callerSid}" cannot write task ${taskId} (teamId=${existing.teamId ?? 'personal'}, owner=${existing.ownerSessionId})`,
          "Call task_list to inspect this caller's visible tasks. Use an active team member session for team tasks or the owner session for personal tasks.",
        );
      }
      // v024 plan §D1 + Step C4:patch.teamId 显式传 string 时校验 caller 在新 team active member
      //（不论 args.teamId 是 update 改 team 还是初始 set,都要 caller 当前在该 team 才能放 task 进去）。
      // 显式传 null（改 personal）不需校验,任何 owner 都可把自己 task 转 personal。
      // undefined（不传）→ 不动 teamId,跳过校验。
      if (args.teamId !== undefined && args.teamId !== null) {
        if (!isCallerInTeam(callerSid, args.teamId)) {
          return err(
            `caller "${callerSid}" is not an active member of teamId "${args.teamId}"`,
            'Use an active team ID, leave teamId unset to keep the current scope, set teamId=null only as the task owner, or join the team in the Agent Deck UI.',
          );
        }
      }
      // **REVIEW_87 MED (reviewer-codex + reviewer-claude 反驳轮共识)**: team-bound → personal 转换
      // （args.teamId === null 且 existing 是 team-bound）必须额外要求 caller == owner。
      // **权限域切换漏洞**:上面 isCallerAuthorizedToWrite 对 team-bound task 只要求 caller 是该 team
      // active member（不要求 owner），而 teamId=null 分支跳过新 team 校验 + repo update 保留原
      // ownerSessionId（闭包锁不可改 owner）→ 非 owner team member 可对他人拥有的共享 task 调
      // task_update({teamId:null}) 把它变成**原 owner 的 personal task**：team 全员（含发起者）失
      // 可见性，只剩原 owner 能看到（用旧域 team-membership 权限授权了切到新域 owner-scoped 的操作，
      // 新域约束 caller==owner 被 args.teamId!==null 短路跳过）。修法:转 personal 必须 caller==owner。
      // 合法路径不误伤:owner 自转 personal（callerSid===ownerSessionId 放行）/ 已是 personal 的改其他
      // 字段（existing.teamId===null 不进本分支，落 isCallerAuthorizedToWrite personal 分支已要求
      // caller==owner）/ A→B 搬运（args.teamId!==null 不进本分支，走上面新 team 校验）。
      if (args.teamId === null && existing.teamId !== null && callerSid !== existing.ownerSessionId) {
        return err(
          `permission denied: caller "${callerSid}" cannot convert team task ${taskId} to personal (only owner "${existing.ownerSessionId}" may convert a team-bound task to personal)`,
          'Only ownerSessionId may set teamId=null. Leave teamId unchanged or ask the owner to perform the conversion.',
        );
      }
      // argsToInputWithoutOwner 已不放 ownerSessionId,patch 不会有 ownerSessionId 键。
      // v024:argsToInputWithoutOwner 已支持 args.teamId 透传到 patch.teamId。
      const patch = argsToInputWithoutOwner(rest);
      // **REVIEW_87 LOW (reviewer-codex)**: 空 patch（caller 只传 taskId 无任何字段）直接返回
      // existing，**不 emit task-changed** —— repo.update 对空 sets 返回 existing 不刷 updated_at
      // （task-repo-crud.ts:105），但旧版 handler 仍 emit kind='updated' 制造无 DB 变更的 realtime
      // 噪声 + 让 tool 描述「updated_at is auto-refreshed」在该路径失真。schema 仅 taskId 必填
      // → task_update({taskId}) 是合法可达输入。提前返回保持「无变更不广播」语义。
      if (Object.keys(patch).length === 0) {
        return ok(existing satisfies TaskUpdateResult);
      }
      const updated = taskRepo.update(taskId, patch);
      if (!updated) {
        return err(
          `task ${taskId} disappeared during update`,
          'Call task_list with the appropriate teamIdFilter, or omit the filter for caller-visible scope, then retry with a returned task ID.',
        );
      }
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
      return err(
        e instanceof Error ? e.message : String(e),
        'If the error identifies invalid input, correct it. For a transient storage error, retry once; if it repeats, stop and inspect Agent Deck main-process logs.',
      );
    }
  },
);
