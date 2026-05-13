/**
 * send_message handler —— 跨 session 消息入队（universal-message-watcher 投递 + 持久化）。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 671-751 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * 顺手修 MED-3 (send teamId 跨污染)：reply_to_message_id 给定时反查 original.teamId
 * 必须 === resolved teamId，避免 caller 把 team A 消息挂到 team B 的 reply chain。
 */

import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { SendMessageArgs } from '../schemas';

export async function sendMessageHandler(
  args: SendMessageArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('send_message', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  const target = sessionRepo.get(args.session_id);
  if (!target) {
    return err(`session ${args.session_id} not found`);
  }
  if (target.lifecycle === 'closed') {
    return err(
      `session ${args.session_id} is closed`,
      'Closed sessions cannot receive new messages. Spawn a new session if you need to continue.',
    );
  }
  if (caller.callerSessionId === args.session_id) {
    return err(
      'cannot send_message to self',
      'A session cannot post a message to its own user turn via MCP.',
    );
  }

  // R3.E0 ADR §5.2 amend：team_id resolve via shared active teams
  const sharedTeams = agentDeckTeamRepo.findSharedActiveTeams(
    caller.callerSessionId,
    args.session_id,
  );
  if (sharedTeams.length === 0) {
    return err(
      'no-shared-team',
      `caller (${caller.callerSessionId.slice(0, 8)}) and target (${args.session_id.slice(0, 8)}) are not in any common active team. Spawn the target via spawn_session({team_name: '...'}) or join an existing team via the application UI before sending messages.`,
    );
  }
  let teamId: string;
  if (args.team_id) {
    if (!sharedTeams.includes(args.team_id)) {
      return err(
        `team-not-shared: team_id ${args.team_id} is not in the shared active set [${sharedTeams.join(', ')}]`,
      );
    }
    teamId = args.team_id;
  } else if (sharedTeams.length === 1) {
    teamId = sharedTeams[0];
  } else {
    return err(
      'ambiguous-team',
      `caller and target share ${sharedTeams.length} active teams [${sharedTeams.join(', ')}]; pass team_id to disambiguate.`,
    );
  }

  // REVIEW_32 follow-up MED-3 (send teamId 跨污染) 修法：reply_to_message_id 给定时反查
  // original.teamId 必须 === resolved teamId，避免 caller 把 team A 消息挂到 team B reply chain。
  // 旧实现只校验 caller/target 共享 team + args.team_id ⊆ sharedTeams，**不**反查
  // original.teamId，错误或恶意 caller 可在 cross-team 投递时把任意 reply_to_message_id 挂到
  // 任意 sharedTeam 的 chain 上 → wait_reply 走 reply_to_message_id 反查会拿到错 team 的 reply，
  // 污染对话链。
  if (args.reply_to_message_id) {
    const original = agentDeckMessageRepo.get(args.reply_to_message_id);
    if (!original) {
      return err(
        `reply_to_message_id ${args.reply_to_message_id} not found`,
        'reply_to_message_id must point to an existing message. Use list_messages or wait_reply to discover live message ids; omit when starting a new topic.',
      );
    }
    if (original.teamId !== teamId) {
      return err(
        `cross-team reply not allowed: reply_to_message_id ${args.reply_to_message_id} belongs to team ${original.teamId}, not target team ${teamId}`,
        'Reply chains are scoped per-team. Use reply_message tool for in-team replies, or omit reply_to_message_id when sending in a different team.',
      );
    }
  }

  // 入队（messageRateLimiter + repo.insert 100KB cap + self-message 防御都在内部）
  // plan team-cohesion-fix-20260513 Phase B Step B2：透传 reply_to_message_id 建对话链
  const result = enqueueAgentDeckMessage({
    teamId,
    fromSessionId: caller.callerSessionId,
    toSessionId: args.session_id,
    body: args.text,
    replyToMessageId: args.reply_to_message_id ?? null,
  });
  if (!result.ok) {
    return err(
      `${result.error} (retryAfterMs=${result.retryAfterMs})`,
      'Per-team rate limit exceeded. Retry after the indicated delay or raise mcpMessageRatePerTeamPerMin in Settings.',
    );
  }
  return ok({
    sessionId: args.session_id,
    teamId,
    messageId: result.message.id,
    replyToMessageId: result.message.replyToMessageId,
    sentAt: result.message.sentAt,
    queued: true,
  });
}
