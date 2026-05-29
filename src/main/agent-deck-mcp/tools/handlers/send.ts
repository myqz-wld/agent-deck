/**
 * send_message handler —— 跨 session 消息入队（universal-message-watcher 投递 + 持久化）。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 671-751 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * MED-3 (send teamId 跨污染) 修法：replyToMessageId 给定时反查 original.teamId
 * 必须 === resolved teamId，避免 caller 把 team A 消息挂到 team B 的 reply chain。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：删 reply_message tool 后所有 reply
 * 改走 send_message + replyToMessageId；J fix 删 → reply 与普通 message 同款 dispatch
 * 进 receiver SDK conversation flow，receiver 自动看到 reply 作为 user-role message。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 */

import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SendMessageArgs, SendMessageResult } from '../schemas';

export const sendMessageHandler = withMcpGuard(
  'send_message',
  async (args: SendMessageArgs, ctx: HandlerContext) => {
    const { caller } = ctx;

    const target = sessionRepo.get(args.sessionId);
    if (!target) {
      return err(`session ${args.sessionId} not found`);
    }
    if (target.lifecycle === 'closed') {
      return err(
        `session ${args.sessionId} is closed`,
        'Closed sessions cannot receive new messages. Spawn a new session if you need to continue.',
      );
    }
    if (caller.callerSessionId === args.sessionId) {
      return err(
        'cannot send_message to self',
        'A session cannot post a message to its own user turn via MCP.',
      );
    }

    // R3.E0 ADR §5.2 amend：teamId resolve via shared active teams
    const sharedTeams = agentDeckTeamRepo.findSharedActiveTeams(
      caller.callerSessionId,
      args.sessionId,
    );
    if (sharedTeams.length === 0) {
      return err(
        'no-shared-team',
        `caller (${caller.callerSessionId.slice(0, 8)}) and target (${args.sessionId.slice(0, 8)}) are not in any common active team. Spawn the target via spawn_session({teamName: '...'}) or join an existing team via the application UI before sending messages.`,
      );
    }
    let teamId: string;
    if (args.teamId) {
      if (!sharedTeams.includes(args.teamId)) {
        return err(
          `team-not-shared: teamId ${args.teamId} is not in the shared active set [${sharedTeams.join(', ')}]`,
        );
      }
      teamId = args.teamId;
    } else if (sharedTeams.length === 1) {
      teamId = sharedTeams[0];
    } else {
      return err(
        'ambiguous-team',
        `caller and target share ${sharedTeams.length} active teams [${sharedTeams.join(', ')}]; pass teamId to disambiguate.`,
      );
    }

    // REVIEW_32 follow-up MED-3 (send teamId 跨污染) 修法：replyToMessageId 给定时反查
    // original.teamId 必须 === resolved teamId，避免 caller 把 team A 消息挂到 team B reply chain。
    // 旧实现只校验 caller/target 共享 team + args.teamId ⊆ sharedTeams，**不**反查
    // original.teamId，错误或恶意 caller 可在 cross-team 投递时把任意 replyToMessageId 挂到
    // 任意 sharedTeam 的 chain 上 → replyToMessageId 反查会拿到错 team 的 reply，
    // 污染对话链。
    if (args.replyToMessageId) {
      const original = agentDeckMessageRepo.get(args.replyToMessageId);
      if (!original) {
        return err(
          `replyToMessageId ${args.replyToMessageId} not found`,
          'replyToMessageId must point to an existing message. Use list_sessions to find live session ids; omit when starting a new topic.',
        );
      }
      if (original.teamId !== teamId) {
        return err(
          `cross-team reply not allowed: replyToMessageId ${args.replyToMessageId} belongs to team ${original.teamId}, not target team ${teamId}`,
          'Reply chains are scoped per-team. Omit replyToMessageId when sending in a different team.',
        );
      }
    }

    // 入队（messageRateLimiter + repo.insert 100KB cap + self-message 防御都在内部）
    // plan team-cohesion-fix-20260513 Phase B Step B2：透传 replyToMessageId 建对话链
    const result = enqueueAgentDeckMessage({
      teamId,
      fromSessionId: caller.callerSessionId,
      toSessionId: args.sessionId,
      body: args.text,
      replyToMessageId: args.replyToMessageId ?? null,
    });
    if (!result.ok) {
      return err(
        `${result.error} (retryAfterMs=${result.retryAfterMs})`,
        'Per-team rate limit exceeded. Retry after the indicated delay or raise mcpMessageRatePerTeamPerMin in Settings.',
      );
    }
    return ok({
      sessionId: args.sessionId,
      teamId,
      messageId: result.message.id,
      replyToMessageId: result.message.replyToMessageId,
      sentAt: result.message.sentAt,
      queued: true,
    } satisfies SendMessageResult);
  },
);
