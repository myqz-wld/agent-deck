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
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
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
import { argsToInputWithoutOwner, getCallerFirstTeamName } from './task-helpers';

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
      const input: TaskCreateInput = {
        ...argsToInputWithoutOwner(args),
        ownerSessionId: callerSid,
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
        sessionManager.ingest({
          sessionId: callerSid,
          agentId: AGENT_ID,
          source: 'sdk',
          kind: 'team-task-created',
          ts: Date.now(),
          payload: {
            teamName: getCallerFirstTeamName(callerSid),
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
