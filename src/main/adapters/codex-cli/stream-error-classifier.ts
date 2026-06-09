import log from '@main/utils/logger';

const logger = log.scope('codex-stream-error-classifier');

const TRANSIENT_STREAM_ERROR_PHRASES = [
  'Reconnecting...',
  'stream disconnected before completion',
  'stream disconnected - retrying sampling request',
  'reconnecting:',
  'app-server event stream disconnected',
  'TCP Connection with remote is closed, trying to reconnect',
] as const;

const STREAM_ERROR_HEURISTIC_RE =
  /\b(retry|retrying|retried|reconnect|reconnecting|reconnected|disconnect|disconnected|disconnecting)\b/i;

const FATAL_STREAM_ERROR_PHRASES = [
  'max retry times reached',
  'exceeded retry limit',
  'Error retrieving',
  'could not retrieve',
  'Could not retrieve',
  'failed to retrieve',
  'Failed to retrieve',
  'exec-server connection disconnected',
  'exec-server transport disconnected',
  'disconnecting slow connection',
  'dropping message for disconnected',
  'Convert it to UTF-8',
  'Fix the config',
  'Too many retransmissions',
] as const;

const STREAM_ERROR_FATAL_RE =
  /(max\s+retr|exceeded\s+retr|exhaust|gave\s+up|maximum\s+retr)/i;

export function classifyStreamErrorEvent(message: string): 'transient' | 'fatal' {
  if (FATAL_STREAM_ERROR_PHRASES.some((p) => message.includes(p))) return 'fatal';
  if (STREAM_ERROR_FATAL_RE.test(message)) return 'fatal';
  if (TRANSIENT_STREAM_ERROR_PHRASES.some((p) => message.includes(p))) return 'transient';
  if (STREAM_ERROR_HEURISTIC_RE.test(message)) {
    logger.warn(
      `[codex-cli/stream-error-classifier] heuristic-only transient match (consider adding to white-list): ${message}`,
    );
    return 'transient';
  }
  return 'fatal';
}

export function extractRetryProgress(message: string): string {
  const m = message.match(/(?:Reconnecting\.\.\.|attempt|retry)\s+(\d+)\s*\/\s*(\d+)/i);
  if (!m) return '';
  return ` 重连尝试 ${m[1]}/${m[2]}`;
}
