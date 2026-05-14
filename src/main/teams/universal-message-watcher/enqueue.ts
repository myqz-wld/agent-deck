/**
 * Caller-facing 入队 API。
 *
 * messageRepo.insert 入口校验前缀拼装 + 入队的便利封装。caller 应用方都走此入口（统一 wire format）。
 *
 * 调用方：IPC handler (`@main/ipc/teams.ts`) + MCP send_message (`@main/agent-deck-mcp/tools/handlers/send.ts`)
 */

import { eventBus } from '@main/event-bus';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
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
