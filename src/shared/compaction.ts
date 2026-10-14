import type { AgentEvent } from './types';

export type CompactionStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

/** Provider-independent, optional evidence. Never fill missing metrics with usage totals. */
export interface CompactionSnapshot {
  id?: string;
  status: CompactionStatus;
  trigger?: string;
  startedAt?: number;
  completedAt?: number;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  revision?: number;
  summary?: string;
  error?: string;
}

export function compactionRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function compactionStatus(value: unknown): CompactionStatus {
  if (value === 'running' || value === 'in_progress') return 'running';
  if (value === 'completed' || value === 'failed') return value;
  if (value === 'interrupted' || value === 'cancelled' || value === 'canceled' || value === 'aborted') return 'interrupted';
  return 'unknown';
}

export function readCompaction(event: AgentEvent): CompactionSnapshot | null {
  const payload = compactionRecord(event.payload);
  const structured = compactionRecord(payload.compaction);
  const command = compactionRecord(payload.sessionCommandStatus);
  const lifecycle = event.kind === 'context-compaction-start' || event.kind === 'context-compaction-end';
  const commandMessage = event.kind === 'message' && payload.role === 'system' && command.command === 'compact';
  if (!lifecycle && !commandMessage && !(event.kind === 'message' && payload.role === 'system' && structured.status)) return null;
  const source = Object.keys(structured).length ? structured : payload;
  const status = compactionStatus(source.status ?? (commandMessage ? command.status
    : event.kind === 'context-compaction-start' ? 'running' : 'completed'));
  const result: CompactionSnapshot = { status };
  for (const field of ['id', 'trigger', 'summary', 'error'] as const) {
    const value = field === 'id' ? source.id ?? source.compactionId : source[field];
    if (typeof value === 'string') result[field] = value;
  }
  for (const field of ['startedAt', 'completedAt', 'preTokens', 'postTokens', 'durationMs', 'revision'] as const) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  if (commandMessage && !Object.keys(structured).length && typeof payload.text === 'string') {
    readStoredCommandDetails(payload.text, result);
  }
  return result;
}

/** Read the exact historical compact-command format; ordinary/user messages never enter here. */
function readStoredCommandDetails(text: string, result: CompactionSnapshot): void {
  const number = (value: string) => Number(value.replaceAll(',', ''));
  const pair = text.match(/Token：([\d,]+) → ([\d,]+)/);
  if (pair) { result.preTokens = number(pair[1]); result.postTokens = number(pair[2]); }
  for (const [field, pattern] of [
    ['preTokens', /压缩前 token：([\d,]+)/],
    ['postTokens', /压缩后 token：([\d,]+)/],
    ['durationMs', /耗时：([\d,.]+)ms/],
  ] as const) {
    const match = text.match(pattern);
    if (match && Number.isFinite(number(match[1]))) result[field] = number(match[1]);
  }
  const trigger = text.match(/触发：([^·\n]+)/)?.[1].trim();
  if (trigger) result.trigger = trigger === '自动' ? 'auto' : trigger === '手动' ? 'manual' : trigger;
  if (result.status === 'failed') {
    result.error = text.replace(/^[^\n]*?\/compact 失败：/, '').trim();
    if (result.error === '操作已中断') result.status = 'interrupted';
  }
}

export function compactionIdentity(event: AgentEvent): string | null {
  const compaction = readCompaction(event);
  return compaction?.id ? JSON.stringify([event.sessionId, event.agentId, compaction.id]) : null;
}

export function compactionTitle(status: CompactionStatus): string {
  return { running: '正在压缩上下文', completed: '上下文已压缩', failed: '上下文压缩失败',
    interrupted: '上下文压缩已中断', unknown: '上下文压缩状态待确认' }[status];
}
