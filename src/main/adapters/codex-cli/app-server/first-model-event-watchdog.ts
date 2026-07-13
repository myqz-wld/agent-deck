import type { CodexAppServerNotification } from './protocol';

/**
 * A turn that app-server accepted but never starts producing model activity otherwise has no
 * natural completion boundary. Keep this comfortably above normal dispatch latency while still
 * recovering well before an interactive session appears permanently stuck.
 */
export const DEFAULT_FIRST_MODEL_EVENT_TIMEOUT_MS = 90_000;

/**
 * Returns true only for activity derived from the model turn. Lifecycle, configuration, warning,
 * retry, and echoed user-input notifications must not disarm the watchdog.
 */
export function isCodexModelActivity(notification: CodexAppServerNotification): boolean {
  const { method } = notification;
  if (method === 'thread/tokenUsage/updated') return true;
  if (method === 'turn/diff/updated' || method === 'turn/plan/updated') return true;
  if (method.startsWith('rawResponseItem/')) return true;
  if (
    method === 'item/agentMessage/delta'
    || method === 'item/reasoning/textDelta'
    || method === 'item/reasoning/summaryTextDelta'
    || method === 'item/plan/delta'
    || method === 'item/commandExecution/outputDelta'
    || method === 'item/mcpToolCall/progress'
  ) return true;
  if (method !== 'item/started' && method !== 'item/completed') return false;

  const itemType = readItemType(notification.params);
  return itemType !== null && itemType !== 'userMessage' && itemType !== 'user_message';
}

export function firstModelEventTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return (
    `Codex 已接受 turn，但 ${seconds} 秒内没有产生首个 model 事件。` +
    'Agent Deck 已中断该 turn 并回收 app-server；为避免重复副作用，不会自动重放这条用户消息。'
  );
}

function readItemType(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const item = (params as { item?: unknown }).item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const type = (item as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}
