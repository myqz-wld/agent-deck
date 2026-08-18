/**
 * shutdown_session handler —— 标记 session lifecycle=closed + abort SDK live query。
 * 不删 events / file_changes / summaries / messages（agent_deck_messages 表）；
 * team_member 行通过 left_at 软退出保留，spawn_link 全量保留。caller 不能 shutdown 自己。
 *
 * 数据保留 invariant（R1 deep review MED-1 + LOW-4 修；A6 / B12 文档同步）：
 *   - lead 在裁决报告 / 历史 review 里仍可引用 closed teammate 的 messages（双 reviewer
 *     SKILL 流程的核心 affordance）；
 *   - list_sessions(spawnedByFilter) 跨会话救火能拿到旧 lead spawn 的 closed reviewer，
 *     team_member.left_at 标记之外行不删；
 *   - spawn_link 保留方便 fan-out / 父子链路审计。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 1020-1054 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { adapterRegistry } from '@main/adapters/registry';
import { retireClosedSessionRuntime } from '@main/adapters/closed-session-runtime-retirement';
import log from '@main/utils/logger';

import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ShutdownSessionArgs, ShutdownSessionResult } from '../schemas';

const logger = log.scope('mcp-shutdown');

export const shutdownSessionHandler = withMcpGuard(
  'shutdown_session',
  async (args: ShutdownSessionArgs, ctx: HandlerContext) => {
    logger.info('[mcp shutdown_session] shutdown requested', {
      callerSessionId: ctx.caller.callerSessionId,
      targetSessionId: args.sessionId,
      reason: args.reason ?? null,
    });
    if (args.sessionId === ctx.caller.callerSessionId) {
      return err(
        'cannot shutdown self',
        'Do not retry. Ask the user to close this session in the Agent Deck UI, or use hand_off_session when transferring work.',
      );
    }
    const session = sessionRepo.get(args.sessionId);
    if (!session) {
      return err(
        `session ${args.sessionId} not found`,
        'Call list_sessions to get a live session ID, then retry.',
      );
    }
    const alreadyClosed = session.lifecycle === 'closed';
    try {
      if (alreadyClosed) {
        // Durable close may win before an adapter's runtime map is retired. Re-run only
        // provider cleanup so the original endedAt and other history remain unchanged.
        await retireClosedSessionRuntime(
          adapterRegistry.get(session.agentId),
          args.sessionId,
        );
      } else {
        await sessionManager.close(args.sessionId);
      }
    } catch (e) {
      return err(
        e instanceof Error ? e.message : String(e),
        '先用 get_session 检查该 session；若仍为 active，请重试一次；若已经 closed 或再次清理失败，请查看 Agent Deck 主进程日志，并在清理 worktree 前重启 Agent Deck。',
      );
    }
    return structuredOk({ sessionId: args.sessionId, lifecycle: 'closed', alreadyClosed } satisfies ShutdownSessionResult);
  },
);
