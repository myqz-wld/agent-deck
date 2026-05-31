/**
 * task_create handler — 创建结构化 task，owner_session_id 闭包注入 caller sid。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式（与现有 10 个 agent-deck-mcp tool 同款）。
 *
 * **D5**: schema 走 makeCtx(args, extra)，callerSessionId 从 HandlerContext.caller.callerSessionId
 * 拿（in-process closure override / HTTP authn / stdio sentinel 三路径已收口）
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_create = false，withMcpGuard 自动 deny stdio sentinel
 * **D7**: ingest 仅在 in-process transport（claude SDK session events 流看得到 team-task-*）；
 *   HTTP transport（codex SDK 子进程）skip ingest（codex SessionDetail 渲染 team-task-* event 未实证）
 *
 * **v024 plan task-team-id-restore-20260525 §D1+D2**: teamId optional field 加 caller 校验
 * （传时 caller 必须在该 team 是 active member，否则 reject;不传 → null personal task）。
 * ingest payload.teamName 同步取 args.teamId lookup（不走 getCallerFirstTeamName 避免多 team
 * caller 显式 teamId=B 但 first active team=A 漂移到 A — Round 1 MED-2 + Round 3 MED-3 修法）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { taskRepo, type TaskCreateInput } from '@main/store/task-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from '@main/adapters/claude-code/sdk-bridge/constants';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskCreateArgs, TaskCreateResult } from '../schemas';
import { argsToInputWithoutOwner, isCallerInTeam } from './task-helpers';

export const taskCreateHandler = withMcpGuard(
  'task_create',
  async (args: TaskCreateArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      // v023 plan §不变量 1：task 必有真实 owner_session_id（FK → sessions(id)）。
      // 兜底 check sessionRepo 防 FK 错（虽然 SQLite throw 也会被 ok/err 兜，
      // 但提早返友好错误信息更利于 caller 诊断 tempKey timing 问题）。
      if (!sessionRepo.get(callerSid)) {
        return err(
          `caller session "${callerSid}" not in sessions table (tempKey window or session not yet committed) — retry after session is fully claimed`,
        );
      }
      // v024 plan §D2:caller 显式传 teamId 时 handler 校验 caller 在该 team active member。
      // 不传 / undefined / null → 落 null personal task,与 caller 是否在 team 无关（D2 用户决策）。
      // **REVIEW_87 LOW (reviewer-claude)**: 用显式 `!= null` 判定替代 truthy `if (args.teamId)`，
      // 并把空串归一到 null。修前 truthy check 让 `teamId=''` 跳过 isCallerInTeam 校验后落
      // `'' ?? null` = `''`（?? 仅 null/undefined 触发）→ 建出 teamId='' 畸形 task（既非 personal
      // 也非合法 team，isCallerInTeam('') 恒 false → 永久无人可读写）。schema teamId .min(1) 当前
      // 挡空串故不可达，但 handler 自身防御不应隐式耦合 schema（纵深防御 + 与 task-update.ts:57
      // 显式 null 判定一致）。
      const normalizedTeamId = args.teamId == null || args.teamId === '' ? null : args.teamId;
      if (normalizedTeamId !== null) {
        if (!isCallerInTeam(callerSid, normalizedTeamId)) {
          return err(
            `caller "${callerSid}" is not an active member of teamId "${normalizedTeamId}" — task_create rejected (v024 plan §D3)`,
            'team-bound task 要求 caller 在该 team 是 active member（agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL 双条件）。Use task_create without teamId for personal task, or join the team first via the application UI.',
          );
        }
      }
      const input: TaskCreateInput = {
        ...argsToInputWithoutOwner(args),
        ownerSessionId: callerSid,
        teamId: normalizedTeamId, // v024 D1+D2:不传 / 空串 = personal task（REVIEW_87 归一空串到 null）
        subject: args.subject,
      };
      const created = taskRepo.create(input);
      eventBus.emit('task-changed', {
        kind: 'created',
        taskId: created.id,
        task: created,
        ownerSessionId: created.ownerSessionId,
        ts: Date.now(),
      });
      // D7：in-process 路径 ingest team-task-created；HTTP/stdio transport skip
      // （codex SDK 子进程 SessionDetail 渲染 team-task-* event 未实证）
      // CHANGELOG_165 修法: 加 `args.teamId` 第二守卫 (truthy check 也覆盖 null/undefined),
      // personal task skip ingest — kind 名 `team-task-created` 与 personal task 语义不符,
      // 且 v024 plan 把 personal task 升为 first-class default 后这条 event 在 ActivityFeed /
      // TeamDetail EventsSection 里全是噪声(尤其 task_create 比 task_update 触发频繁,泛滥更严重)。
      // eventBus.emit('task-changed') 不受影响仍发,UI TasksSection / task_list 实时性不丢。
      if (ctx.caller.transport === 'in-process' && created.teamId) {
        // v024 plan Round 1 MED-2 + Round 3 MED-3 修法:teamName 取自 created.teamId lookup
        //（不走 getCallerFirstTeamName 避免多 team caller 显式 teamId=B 但 first active team=A
        // 漂移到 A）。守卫保证 created.teamId 必非空,直接 lookup。
        // REVIEW_87: 守卫从 args.teamId 改 created.teamId（= normalizedTeamId，空串已归一 null），
        // 与 task-update.ts 用 updated.teamId 对称（personal task 含归一后的空串都 skip ingest）。
        // 实际接口 agentDeckTeamRepo.get(teamId)?.name（Round 3 MED-3:`findById` 不存在）。
        const teamName = agentDeckTeamRepo.get(created.teamId)?.name ?? null;
        sessionManager.ingest({
          sessionId: callerSid,
          agentId: AGENT_ID,
          source: 'sdk',
          kind: 'team-task-created',
          ts: Date.now(),
          payload: {
            teamName,
            taskId: created.id,
            description: created.subject,
            assignee: created.activeForm ?? null,
          },
        });
      }
      return ok(created satisfies TaskCreateResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
