/**
 * wait_reply handler —— 等某条 message 的 reply 到达（plan team-cohesion-fix-20260513
 * Phase B Step B4 / B6）：DB query + universal-message-watcher event listener，
 * filter `reply_to_message_id === args.message_id` + 方向校验 (REVIEW_32 HIGH-3)。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 820-940 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 */

import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import { eventBus } from '@main/event-bus';
import type { AgentDeckMessage } from '@shared/types';

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { WaitReplyArgs } from '../schemas';

export async function waitReplyHandler(
  args: WaitReplyArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('wait_reply', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  // 反查原 msg 校验存在
  const original = agentDeckMessageRepo.get(args.message_id);
  if (!original) {
    return err(
      `original message ${args.message_id} not found`,
      'message_id must point to an existing message (returned by send_message / reply_message). Use list_messages to discover live ids.',
    );
  }

  // 防 race：注册 listener 之前先查一次，reply 可能已到（caller wait_reply 慢于 reply 到达）
  const replyProj = (msg: AgentDeckMessage) => ({
    messageId: msg.id,
    text: msg.body,
    sentAt: msg.sentAt,
    fromSessionId: msg.fromSessionId,
  });
  // REVIEW_32 HIGH-3：reply 方向校验 — 真 reply 必须来自 original.toSessionId（对方）回到 caller。
  // 修前 nudge enqueue 用 fromSessionId=caller, replyToMessageId=args.message_id，
  // findRepliesByMessageId 会把 nudge 自身当成 reply，wait_reply 假成功（lead 误以为 teammate 已回）。
  // 此过滤同时把潜在的「caller 自己 send_message 时手填 reply_to_message_id 指向自己等的 msg」
  // 这种边缘 misuse 也排除，只接受真正的对话反向消息。
  const isLegitReply = (msg: AgentDeckMessage): boolean =>
    msg.fromSessionId === original.toSessionId && msg.toSessionId === original.fromSessionId;
  const existing = agentDeckMessageRepo.findRepliesByMessageId(args.message_id).filter(isLegitReply);
  if (existing.length > 0) {
    return ok({
      reply: replyProj(existing[0]),
      nudgesSent: 0,
      timedOut: false,
    });
  }

  // 监听 universal-message-watcher 入队事件 + 状态变更事件，filter replyToMessageId
  let resolved = false;
  let nudgesSent = 0;
  let nudgeTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let unsubscribeEnq: (() => void) | null = null;
  let unsubscribeChange: (() => void) | null = null;

  const cleanup = () => {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (unsubscribeEnq) unsubscribeEnq();
    if (unsubscribeChange) unsubscribeChange();
  };

  return new Promise((resolve) => {
    const checkReply = () => {
      if (resolved) return;
      // REVIEW_32 HIGH-3：同 existing 检查，过滤出方向正确的 reply（排除 nudge 自循环）
      const replies = agentDeckMessageRepo
        .findRepliesByMessageId(args.message_id)
        .filter(isLegitReply);
      if (replies.length > 0) {
        resolved = true;
        cleanup();
        resolve(
          ok({
            reply: replyProj(replies[0]),
            nudgesSent,
            timedOut: false,
          }),
        );
      }
    };

    const onEnqueued = (e: {
      id: string;
      teamId: string;
      fromSessionId: string;
      toSessionId: string;
    }) => {
      // 任何 message-enqueued 触发都重 query 一次（filter 在 repo 层做更准确）
      if (e.teamId === original.teamId) checkReply();
    };
    const onChanged = (e: { id: string }) => {
      // status / cancellation 也可能影响 wait（cancelled reply 不算）
      if (e.id) checkReply();
    };
    unsubscribeEnq = eventBus.on('agent-deck-message-enqueued', onEnqueued);
    unsubscribeChange = eventBus.on('agent-deck-message-status-changed', onChanged);

    // nudge timer：nudge_text 非空时，nudge_after_ms 后 enqueue 一条催促消息
    if (args.nudge_text) {
      const nudgeDelay =
        args.nudge_after_ms ?? Math.max(5_000, Math.min(args.timeout_ms / 2, 1_800_000));
      nudgeTimer = setTimeout(() => {
        if (resolved) return;
        // 给原 msg 的接收方塞一条 nudge（reply_to_message_id 指向原 msg；fromSessionId 是 caller）
        try {
          enqueueAgentDeckMessage({
            teamId: original.teamId,
            fromSessionId: caller.callerSessionId,
            toSessionId: original.toSessionId,
            body: args.nudge_text!,
            replyToMessageId: args.message_id,
          });
          nudgesSent++;
        } catch (e) {
          console.warn('[mcp wait_reply] nudge enqueue failed:', e);
        }
      }, nudgeDelay);
    }

    // total timeout
    timeoutTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(
        ok({
          reply: null,
          nudgesSent,
          timedOut: true,
        }),
      );
    }, args.timeout_ms);
  });
}
