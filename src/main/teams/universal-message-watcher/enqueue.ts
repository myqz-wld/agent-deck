/**
 * Caller-facing 入队 API。
 *
 * messageRepo.insert 入口校验前缀拼装 + 入队的便利封装。caller 应用方都走此入口（统一 wire format）。
 *
 * 调用方：IPC handler (`@main/ipc/teams.ts`) + MCP send_message (`@main/agent-deck-mcp/tools/handlers/send.ts`)
 */

import { eventBus } from '@main/event-bus';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { MessageInvariantError, MAX_BODY_LENGTH } from '@main/store/message-delivery-state';
import { settingsStore } from '@main/store/settings-store';
import type { AgentDeckMessage } from '@shared/types';
import { messageRateLimiter } from './rate-limiter';

/** caller-side 校验前缀拼装 + 入队的便利封装。caller 应用方都走此入口（统一 wire format）。 */
export interface EnqueueMessageInput {
  teamId: string;
  fromSessionId: string;
  toSessionId: string;
  body: string;
  /**
   * plan team-cohesion-fix-20260513 Phase B Step B1：可选对话链关联。
   * 非 NULL 时该 msg 是对 reply_to_message_id 指向的原 msg 的 reply（wait_reply 走此字段反查）。
   */
  replyToMessageId?: string | null;
}

/**
 * 入队一条 cross-adapter message（供 IPC handler / MCP send_message 调用）。
 *
 * 入口校验顺序：
 * 1. body 长度（messageRepo.insert 内部 100KB cap）
 * 2. self-message 防御（messageRepo.insert 内部）
 * 3. team / member 关系校验（caller 自己负责，因为 IPC vs MCP caller 有不同 ACL）
 * 4. per-team rate limit（settings.mcpMessageRatePerTeamPerMin，默认 60/min）
 *
 * **不**做「team active / archived」校验：archived team 的 send_message 由 caller 自己拒；
 * 此处入队只校验数据完整性（与老 messageRepo.insert 注释一致）。
 */
export function enqueueAgentDeckMessage(input: EnqueueMessageInput): {
  ok: true;
  message: AgentDeckMessage;
} | {
  ok: false;
  error: 'rate-limit-exceeded';
  retryAfterMs: number;
} {
  const limit = settingsStore.get('mcpMessageRatePerTeamPerMin') ?? 60;
  // 同步更新当前 limit 到 limiter（settings hot-toggle 立即生效）
  messageRateLimiter.setLimits(limit, 60_000);
  const now = Date.now();
  // **REVIEW_86 LOW (reviewer-claude + reviewer-codex 双方独立)**: cheap pre-validation 前置到
  // tryConsume 之前。旧版先扣 token 再 insert，但 messageRepo.insert 仍会对 self-message(from==to) /
  // 空 body / body>MAX_BODY_LENGTH 抛 MessageInvariantError（crud.ts:32-44）。MCP send.ts 入口已挡
  // 这些，但 IPC teams.ts:254 仅校验 body 非空（不挡 from==to / 不挡超长）→ 非法 IPC 输入 insert
  // 抛错时 token 已扣但无 message 入队，污染该 team 60/min 配额（60s 自愈）。
  // 修法:在 tryConsume 前做与 insert 同款的 cheap validation（不写库），非法输入直接抛 →
  // token 未扣。**不改 tryConsume↔insert 顺序**（保持 rate-limited 时不 insert 的 backpressure
  // 语义，避免「先插后扣」留 orphan pending 行被 watcher 误投）。validation 规则与 crud.ts insert
  // 保持同款（self / 空 / 超长）；insert 内仍有同款 check 作 SSOT 双层防御（DB CHECK 第三层）。
  if (input.fromSessionId === input.toSessionId) {
    throw new MessageInvariantError(
      `self-message not allowed: from=${input.fromSessionId} == to=${input.toSessionId}`,
    );
  }
  if (!input.body || input.body.length === 0) {
    throw new MessageInvariantError('body 不能为空');
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    throw new MessageInvariantError(`body 长度 ${input.body.length} 超过 ${MAX_BODY_LENGTH}`);
  }
  if (!messageRateLimiter.tryConsume(input.teamId, now)) {
    return {
      ok: false,
      error: 'rate-limit-exceeded',
      retryAfterMs: messageRateLimiter.retryAfterMs(input.teamId, now),
    };
  }
  const message = agentDeckMessageRepo.insert(input);
  // emit 让 watcher 立刻 process（debounced 50ms）
  eventBus.emit('agent-deck-message-enqueued', {
    id: message.id,
    teamId: message.teamId,
    fromSessionId: message.fromSessionId,
    toSessionId: message.toSessionId,
  });
  return { ok: true, message };
}
