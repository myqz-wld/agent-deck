/**
 * check_reply handler — wait_reply 的非阻塞配对版（plan mcp-bug-and-feature-batch-20260513
 * Phase 1 Step 1.3）。
 *
 * 用途：lead 调 send_message 后，可以选 wait_reply 阻塞等 reply（lead 等期间不能从 user
 * 收新 message），或者循环调 check_reply(message_id) 立即返回 { reply | null }，自己控制
 * poll 节奏 + 期间能处理其他 user input。
 *
 * 与 wait_reply 共用 isLegitReply / replyProj helper（在 ../helpers.ts），保证 reply 方向
 * 校验与投影格式完全一致。返回结构 { reply, timedOut: false } 与 wait_reply 同款，方便
 * caller 用同一套消费代码。
 */

import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';

import {
  denyExternalIfNotAllowed,
  err,
  isLegitReply,
  ok,
  replyProj,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { CheckReplyArgs } from '../schemas';

export async function checkReplyHandler(
  args: CheckReplyArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('check_reply', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  const original = agentDeckMessageRepo.get(args.message_id);
  if (!original) {
    return err(
      `original message ${args.message_id} not found`,
      'message_id must point to an existing message (returned by send_message / reply_message). Use list_messages to discover live ids.',
    );
  }

  const replies = agentDeckMessageRepo
    .findRepliesByMessageId(args.message_id)
    .filter((msg) => isLegitReply(msg, original));

  if (replies.length > 0) {
    return ok({
      reply: replyProj(replies[0]!),
      timedOut: false,
    });
  }

  return ok({
    reply: null,
    timedOut: false,
  });
}
