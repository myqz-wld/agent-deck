/**
 * wait_reply handler —— 等某条 message 的 reply 到达（plan team-cohesion-fix-20260513
 * Phase B Step B4 / B6）：DB query + universal-message-watcher event listener，
 * filter `reply_to_message_id === args.message_id` + 方向校验 (REVIEW_32 HIGH-3)。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 820-940 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * isLegitReply / replyProj 已抽到 ../helpers.ts（plan mcp-bug-and-feature-batch-20260513
 * Phase 1 Step 1.3，与 check_reply tool 共用）。
 *
 * **nudge 死锁修（plan mcp-handoff-fix-and-skill-timer-20260514 Phase A2 / R1 deep
 * review HIGH-2）**：内置 `nudge_text` 启用时，wait_reply enqueue 一条 nudge message
 * 给 teammate；按 wire format invariant（universal-message-watcher.buildWireBody）该
 * nudge body 注入 `[msg <NUDGE_ID>]` prefix（不是 ORIGINAL_ID）。teammate 协议
 * （reviewer-{claude,codex}.md §核心纪律 第 9 条）regex 抓**第一个** `[msg ...]` →
 * 抓到 NUDGE_ID → reply_message({reply_to_message_id: NUDGE_ID})。所以 reply DB 行的
 * reply_to_message_id = NUDGE_ID 而非 ORIGINAL_ID。
 *
 * 修法：发出去的每条 nudge 把 message.id 收集到本闭包 `nudgeMessageIds`，checkReply
 * 时**同时查 originalId + 所有 nudgeIds**，只要任一命中即认为收到 reply。OK return 加
 * `nudgeMessageIds: string[]` 字段方便 caller 自检（独立旁路：caller 也可用 check_reply
 * 自己 poll nudgeIds）。**不动 wire format**（不破 reviewer 协议 invariant）。
 */

import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import { eventBus } from '@main/event-bus';

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

  // nudge id 收集容器：每发一条 nudge push 一个 id；checkReply 时双查 originalId + nudgeIds。
  // 闭包变量必须在 listener 注册前声明（onEnqueued / checkReply 都关 close 这个 ref）。
  const nudgeMessageIds: string[] = [];

  /**
   * 双查辅助：originalId 查一遍 + 每个 nudgeId 各查一遍，flat 后第一个 legit reply 即返回。
   * 不去重 / 不排序：同一 reply 不可能同时 reply 多个 messageId（DB 单行 reply_to_message_id 单值）。
   */
  const findRepliesAcrossAllAnchors = () => {
    const allAnchors = [args.message_id, ...nudgeMessageIds];
    return allAnchors.flatMap((mid) =>
      agentDeckMessageRepo.findRepliesByMessageId(mid).filter((msg) => isLegitReply(msg, original)),
    );
  };

  // 防 race：注册 listener 之前先查一次（仅 originalId，nudgeIds 此时还是空）
  const existing = findRepliesAcrossAllAnchors();
  if (existing.length > 0) {
    return ok({
      reply: replyProj(existing[0]!),
      nudgesSent: 0,
      nudgeMessageIds,
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
      // REVIEW_32 HIGH-3：filter 方向（排除 nudge 自循环）。Phase A2：双查 originalId +
      // nudgeIds（解 nudge 死锁，详 file header）。
      const replies = findRepliesAcrossAllAnchors();
      if (replies.length > 0) {
        resolved = true;
        cleanup();
        resolve(
          ok({
            reply: replyProj(replies[0]!),
            nudgesSent,
            nudgeMessageIds,
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
          const enqueueResult = enqueueAgentDeckMessage({
            teamId: original.teamId,
            fromSessionId: caller.callerSessionId,
            toSessionId: original.toSessionId,
            body: args.nudge_text!,
            replyToMessageId: args.message_id,
          });
          if (enqueueResult.ok) {
            // Phase A2 nudge 死锁修：捕获 nudgeMessageId 进双查 anchor 列表。
            // 必须在 nudgesSent++ 前 push，避免 race（虽然 onEnqueued 触发时 checkReply
            // 不会立刻命中——teammate 处理 nudge 需要时间——但语义上保持「先记录再宣告
            // 已发」更稳）。
            nudgeMessageIds.push(enqueueResult.message.id);
            nudgesSent++;
          } else {
            // rate-limit-exceeded：仅 warn，不抛（沿用历史行为）
            console.warn('[mcp wait_reply] nudge enqueue failed:', enqueueResult.error);
          }
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
          nudgeMessageIds,
          timedOut: true,
        }),
      );
    }, args.timeout_ms);
  });
}
