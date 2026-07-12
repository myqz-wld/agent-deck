/**
 * sendMessage pre-condition checks（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.sendMessage 内 3 段直线 validation（长度上限 / 队列上限 /
 * pending warning emit）。把校验逻辑收口到一处，让 facade sendMessage 只关心拉
 * recoverer 兜底 + push pendingUserMessages + emit user message 的主流程。
 *
 * 行为（保持原 sendMessage 内联实现等价）：
 * 1. text.length > MAX_MESSAGE_LENGTH → 抛错（让 IPC handler 把错误抛给 renderer，
 *    UI 显示红条提示精简或拆分）
 * 2. pendingUserMessages.length >= MAX_PENDING_MESSAGES → 抛错（让 UI 给用户明确反馈）
 * 3. 三 pending Map 任一非空 → emit 一条 error: true 的警告 message（避免用户以为
 *    Claude 死了；SDK query() 正卡在 await canUseTool 的 Promise，新消息会进队列但
 *    短时间不会被消费）
 */

import type { AgentEvent } from '@shared/types';
import { AGENT_ID, MAX_MESSAGE_LENGTH, MAX_PENDING_MESSAGES } from './constants';
import type { InternalSession } from './types';

/**
 * sendMessage 入口三段 pre-condition check。命中前两条直接抛错；第三条 side-effect emit。
 */
export function validateSendMessageOrThrow(
  s: InternalSession,
  sessionId: string,
  text: string,
  emit: (e: AgentEvent) => void,
  allowQueueOverflow = false,
): void {
  validateMessageLengthOrThrow(text);
  validateSessionAcceptsMessageOrThrow(s, sessionId);

  // 队列上限：超过就拒绝排队。
  if (!allowQueueOverflow && s.pendingUserMessages.length >= MAX_PENDING_MESSAGES) {
    throw new Error(
      `待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条。请先处理 pending 请求（权限/提问/计划批准）` +
        `或等 Claude 消费当前队列再继续发送。`,
    );
  }

  // 已有未响应的权限/提问/计划批准时，插一条警告 message。
  const pendCount =
    s.pendingPermissions.size + s.pendingAskUserQuestions.size + s.pendingExitPlanModes.size;
  if (pendCount > 0) {
    emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ 还有 ${pendCount} 个待你处理的请求（权限/提问/计划批准）。` +
          `你这条消息会被排队，但 Claude 要等你先处理完上面的请求才会看到它。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}

/** A committed handoff owns the old runtime, so no direct caller may refill its input queue. */
export function validateSessionAcceptsMessageOrThrow(
  session: InternalSession,
  sessionId: string,
): void {
  if (session.retireRequested) {
    throw new Error(`会话 ${sessionId} 已完成交接，旧会话不再接收消息。`);
  }
}

/** Length validation is retained even when handoff temporarily owns queue backpressure. */
export function validateMessageLengthOrThrow(text: string): void {
  // REVIEW_24 HIGH-2 follow-up：单条字符长度上限（与 messageRepo cap 全局对齐）。
  // attachments 走 lazy thunk 内 fs.readFile，不算在 text length 内（IPC 层独立 30MB 校验）。
  const len = text.length;
  if (len > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
    );
  }
}
