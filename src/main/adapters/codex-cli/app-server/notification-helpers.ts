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

export type TerminalNotificationState =
  | 'none'
  | 'retrying'
  | 'other-turn'
  | 'unattributed-completion'
  | 'malformed'
  | 'terminal';

/** Strict terminal parsing used by the turn queue; malformed completion can never become success. */
export function classifyTerminalForTurn(
  notification: CodexAppServerNotification,
  activeTurnId: string | null,
): TerminalNotificationState {
  if (notification.method === 'turn/completed') {
    const params = asObject(notification.params);
    const turn = asObject(params?.turn);
    if (!turn) return 'malformed';
    const turnId = typeof turn.id === 'string' && turn.id.trim() ? turn.id : null;
    if (!turnId) return activeTurnId ? 'unattributed-completion' : 'malformed';
    if (activeTurnId && turnId !== activeTurnId) return 'other-turn';
    if (
      turn.status !== 'completed' &&
      turn.status !== 'interrupted' &&
      turn.status !== 'failed'
    ) {
      return 'malformed';
    }
    return 'terminal';
  }
  if (notification.method !== 'error') return 'none';
  const params = asObject(notification.params);
  if (!params) return 'malformed';
  if (params.willRetry === true) return 'retrying';
  const turnId = typeof params.turnId === 'string' && params.turnId.trim()
    ? params.turnId
    : null;
  if (activeTurnId && turnId && turnId !== activeTurnId) return 'other-turn';
  const error = asObject(params.error);
  if (!error || typeof error.message !== 'string' || !error.message.trim()) return 'malformed';
  return 'terminal';
}

export function readCompletedAgentMessageText(notification: CodexAppServerNotification): string {
  if (notification.method !== 'item/completed') return '';
  const params = asObject(notification.params);
  const item = asObject(params?.item);
  if (item?.type !== 'agentMessage') return '';
  return typeof item.text === 'string' ? item.text : '';
}

export interface CodexTerminalErrorEvidence {
  message: string;
  codexErrorInfo: string | null;
}

export class CodexAppServerTurnError extends Error {
  constructor(
    message: string,
    readonly codexErrorInfo: string | null,
  ) {
    super(message);
    this.name = 'CodexAppServerTurnError';
  }
}

export function readTerminalError(
  notification: CodexAppServerNotification,
): CodexTerminalErrorEvidence | null {
  if (notification.method === 'turn/completed') {
    const params = asObject(notification.params);
    const turn = asObject(params?.turn);
    if (!turn) return terminalError('Codex app-server returned a malformed turn completion');
    if (turn.status === 'completed') return null;
    if (turn.status === 'interrupted') return terminalError('Codex app-server turn interrupted');
    if (turn.status === 'failed') {
      const error = asObject(turn.error);
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'Codex app-server turn failed';
      return terminalError(message, error?.codexErrorInfo);
    }
    return terminalError('Codex app-server returned a malformed turn completion');
  }
  if (notification.method !== 'error') return null;
  const params = asObject(notification.params);
  if (params?.willRetry === true) return null;
  const error = asObject(params?.error);
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : 'Codex app-server turn failed';
  return terminalError(message, error?.codexErrorInfo);
}

function terminalError(
  message: string,
  codexErrorInfo?: unknown,
): CodexTerminalErrorEvidence {
  return {
    message,
    codexErrorInfo:
      typeof codexErrorInfo === 'string' && codexErrorInfo.trim()
        ? codexErrorInfo.trim()
        : null,
  };
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
