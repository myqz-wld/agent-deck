/**
 * task_create handler — 创建结构化 task，owner_session_id 闭包注入 caller sid。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：从 src/main/task-manager/tools.ts
 * 抽出，转 makeCtx + HandlerContext.caller 模式（与现有 10 个 agent-deck-mcp tool 同款）。
 *
 * **D5**: schema 走 makeCtx(args, extra)，caller_session_id 从 HandlerContext.caller.callerSessionId
 * 拿（in-process closure override / HTTP authn / stdio sentinel 三路径已收口）
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_create = false，withMcpGuard 自动 deny stdio sentinel
 * **D7**: ingest 仅在 in-process transport（claude SDK session events 流看得到 team-task-*）；
 *   HTTP transport（codex SDK 子进程）skip ingest（codex SessionDetail 渲染 team-task-* event 未实证）
 *
 * **v024 plan task-team-id-restore-20260525 §D1+D2**: team_id optional field 加 caller 校验
 * （传时 caller 必须在该 team 是 active member，否则 reject;不传 → null personal task）。
 * ingest payload.teamName 同步取 args.team_id lookup（不走 getCallerFirstTeamName 避免多 team
 * caller 显式 team_id=B 但 first active team=A 漂移到 A — Round 1 MED-2 + Round 3 MED-3 修法）。
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
      // v024 plan §D2:caller 显式传 team_id 时 handler 校验 caller 在该 team active member。
      // 不传 / undefined / null → 落 null personal task,与 caller 是否在 team 无关（D2 用户决策）。
      if (args.team_id) {
        if (!isCallerInTeam(callerSid, args.team_id)) {
          return err(
            `caller "${callerSid}" is not an active member of team_id "${args.team_id}" — task_create rejected (v024 plan §D3)`,
            'team-bound task 要求 caller 在该 team 是 active member（agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL 双条件）。Use task_create without team_id for personal task, or join the team first via the application UI.',
          );
        }
      }
      const input: TaskCreateInput = {
        ...argsToInputWithoutOwner(args),
        ownerSessionId: callerSid,
        teamId: args.team_id ?? null, // v024 D1+D2:不传 = personal task
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
      if (ctx.caller.transport === 'in-process') {
        // v024 plan Round 1 MED-2 + Round 3 MED-3 修法:teamName 取自 args.team_id lookup
        //（不走 getCallerFirstTeamName 避免多 team caller 显式 team_id=B 但 first active team=A
        // 漂移到 A）。args.team_id 为空 → null personal task,teamName 也为 null。
        // 实际接口 agentDeckTeamRepo.get(teamId)?.name（Round 3 MED-3:`findById` 不存在）。
        const teamName = args.team_id
          ? (agentDeckTeamRepo.get(args.team_id)?.name ?? null)
          : null;
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
