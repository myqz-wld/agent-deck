/**
 * reply_message handler —— send_message 的语法糖（plan team-cohesion-fix-20260513 Phase B
 * Step B3）：自动反查 original message 的 to_session_id / team_id，强制 caller 必须是
 * original message 的 receiver（你只能回复给你的消息）。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 754-817 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { ReplyMessageArgs } from '../schemas';

export async function replyMessageHandler(
  args: ReplyMessageArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('reply_message', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  // 反查原 msg
  const original = agentDeckMessageRepo.get(args.reply_to_message_id);
  if (!original) {
    return err(
      `original message ${args.reply_to_message_id} not found`,
      'reply_to_message_id must point to an existing message. Use list_messages or wait_reply to discover live message ids.',
    );
  }
  // 安全：caller 必须是原 msg 的 to_session_id（你只能回复给你的 msg）
  if (original.toSessionId !== caller.callerSessionId) {
    return err(
      'cannot reply: caller is not the recipient of the original message',
      `Original message was sent to ${original.toSessionId.slice(0, 8)}, but caller is ${caller.callerSessionId.slice(0, 8)}. You can only reply to messages addressed to you.`,
    );
  }
  // 自动算 to (= 原 msg 的 from) + team
  const toSessionId = original.fromSessionId;
  const teamId = original.teamId;
  // 防御：原 from 仍在 sessions 表 + lifecycle 不是 closed
  const target = sessionRepo.get(toSessionId);
  if (!target) {
    return err(`reply target session ${toSessionId} not found (original sender no longer exists)`);
  }
  if (target.lifecycle === 'closed') {
    return err(
      `reply target session ${toSessionId} is closed`,
      'The original sender has been closed; reply cannot be delivered.',
    );
  }

  const result = enqueueAgentDeckMessage({
    teamId,
    fromSessionId: caller.callerSessionId,
    toSessionId,
    body: args.text,
    replyToMessageId: args.reply_to_message_id,
  });
  if (!result.ok) {
    return err(
      `${result.error} (retryAfterMs=${result.retryAfterMs})`,
      'Per-team rate limit exceeded. Retry after the indicated delay or raise mcpMessageRatePerTeamPerMin in Settings.',
    );
  }
  return ok({
    sessionId: toSessionId,
    teamId,
    messageId: result.message.id,
    replyToMessageId: args.reply_to_message_id,
    sentAt: result.message.sentAt,
    queued: true,
  });
}
