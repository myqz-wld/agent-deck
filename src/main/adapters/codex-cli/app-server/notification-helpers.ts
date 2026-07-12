import type { CodexAppServerNotification, JsonRpcResponse } from './protocol';

export function getNotificationThreadId(notification: CodexAppServerNotification): string | null {
  const params = notification.params;
  if (!params || typeof params !== 'object') return null;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' ? threadId : null;
}

export function getNotificationTurnId(notification: CodexAppServerNotification): string | null {
  const params = notification.params;
  if (!params || typeof params !== 'object') return null;
  const directTurnId = (params as { turnId?: unknown }).turnId;
  if (typeof directTurnId === 'string') return directTurnId;
  const turn = (params as { turn?: { id?: unknown } }).turn;
  return typeof turn?.id === 'string' ? turn.id : null;
}

export function isTerminalForTurn(
  notification: CodexAppServerNotification,
  activeTurnId: string | null,
  turnStartSeen: boolean,
): boolean {
  if (notification.method === 'turn/completed') {
    const turn = (notification.params as { turn?: { id?: unknown } } | undefined)?.turn;
    if (activeTurnId) return turn?.id === activeTurnId;
    // activeTurnId 未知时按 FIFO 时序判别：本 turn 的 completed 不可能先于自己的 started
    // 到达（同一 stdout 管道顺序投递）→ 未见 started 的 completed 是上一个 turn 的迟到
    // 尾包，不是本 turn terminal（详 runTurn 内 turnStartSeen 注释）。见过 started 但
    // turn id 未解析出时退回旧行为（completed 即 terminal）。
    return turnStartSeen;
  }
  if (notification.method !== 'error') return false;
  const params = notification.params as { willRetry?: unknown; turnId?: unknown } | undefined;
  if (params?.willRetry === true) return false;
  return !activeTurnId || params?.turnId === undefined || params.turnId === activeTurnId;
}

export function readCompletedAgentMessageText(notification: CodexAppServerNotification): string {
  if (notification.method !== 'item/completed') return '';
  const params = asObject(notification.params);
  const item = asObject(params?.item);
  if (item?.type !== 'agentMessage') return '';
  return typeof item.text === 'string' ? item.text : '';
}

export function readTerminalErrorText(notification: CodexAppServerNotification): string {
  if (notification.method !== 'error') return '';
  const params = asObject(notification.params);
  if (params?.willRetry === true) return '';
  const error = asObject(params?.error);
  return typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : 'Codex app-server turn failed';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function formatRpcError(error: JsonRpcResponse['error']): string {
  if (!error) return 'Unknown Codex app-server error';
  if (typeof error === 'string') return error;
  const message = error.message ?? 'Unknown Codex app-server error';
  return error.code == null ? message : `${message} (code ${error.code})`;
}
