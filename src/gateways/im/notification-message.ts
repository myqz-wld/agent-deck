import { assertFeishuMethod } from './client-pool';
import { validateHistoryResult } from './core-output';
import { FeishuGatewayError } from './errors';
import { redactJson, truncateUtf8 } from './redaction';
import type { ConnectedFeishuClient, FeishuGatewayLimits, NotificationEvent } from './types';

/** Read only the immutable event named by Core; never substitute a newer assistant response. */
export async function readFeishuAssistantMessage(
  connected: ConnectedFeishuClient,
  event: NotificationEvent,
  limits: FeishuGatewayLimits,
  remaining: () => number,
): Promise<string | null> {
  if (!event.entityId || event.persisted?.kind !== 'message') return null;
  assertFeishuMethod(connected.hello, 'session.history');
  // Core clips each history field at 8 KiB. Keep each response below the transport frame budget.
  const pageSize = Math.min(limits.maxHistoryEntries, 4);
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < limits.maxNotificationCoreRequests; page += 1) {
    const raw = await connected.client.request('session.history', {
      sessionId: event.entityId, limit: pageSize, ...(cursor ? { cursor } : {}),
    }, { deadlineMs: remaining() });
    const result = validateHistoryResult(raw, event.entityId, limits);
    if (result.entries.length > pageSize) {
      throw new FeishuGatewayError('invalid_core_response', 'History page exceeds requested bound');
    }
    const target = result.entries.find(entry =>
      entry.sequence === event.persisted!.eventId && entry.id === `event-${event.persisted!.eventId}`);
    if (target) {
      if (target.role !== 'assistant' || typeof target.content !== 'string' || !target.content.trim()) {
        return null;
      }
      return String(redactJson(target.content, {
        maxDepth: 1, maxEntries: 1, maxStringBytes: limits.maxOutputBytes,
      }));
    }
    if (!result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) {
      throw new FeishuGatewayError('invalid_core_response', 'History pagination did not advance');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return truncateUtf8('有一条较早的会话消息未能自动读取。请发送 /history 查看。', limits.maxOutputBytes);
}
