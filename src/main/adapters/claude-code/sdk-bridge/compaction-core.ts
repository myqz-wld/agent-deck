import type { AgentEvent } from '@shared/types';
import { compactionRecord, type CompactionSnapshot } from '@shared/compaction';
import { buildClaudeCompactMessageText } from '../compact-message';
import { claudeCompactFailureTextCore } from './message-translation-state-core';

export interface ClaudeCompactionOwner {
  activeCompaction?: { id: string; startedAt: number };
  compactionSequence?: number;
  expectedClose?: boolean;
}
type Emit = (kind: AgentEvent['kind'], payload: unknown) => void;

function identity(owner: ClaudeCompactionOwner, message: Record<string, unknown>, ts: number): string {
  if (owner.activeCompaction) return owner.activeCompaction.id;
  if (typeof message.uuid === 'string' && message.uuid) return `claude:${message.uuid}`;
  owner.compactionSequence = (owner.compactionSequence ?? 0) + 1;
  return `claude:${ts}:${owner.compactionSequence}`;
}

export function emitClaudeCompactionStatus(owner: ClaudeCompactionOwner, message: Record<string, unknown>, emit: Emit, ts: number): void {
  if (owner.expectedClose) return;
  const failure = claudeCompactFailureTextCore(message);
  if (failure) {
    const compaction: CompactionSnapshot = {
      id: identity(owner, message, ts), status: 'failed',
      ...owner.activeCompaction, completedAt: ts,
      error: typeof message.compact_error === 'string' ? message.compact_error : '压缩未能完成',
    };
    owner.activeCompaction = undefined;
    emit('message', { text: failure, role: 'system', error: true, compaction,
      sessionCommandStatus: { command: 'compact', status: 'failed' } });
  } else if (message.status === 'compacting' && !owner.activeCompaction) {
    owner.activeCompaction = { id: identity(owner, message, ts), startedAt: ts };
    emit('context-compaction-start', { compaction: { ...owner.activeCompaction, status: 'running' } });
  }
}

export function emitClaudeCompactCompletion(owner: ClaudeCompactionOwner, message: Record<string, unknown>, emit: Emit, ts: number): void {
  const metadata = compactionRecord(message.compact_metadata);
  const compaction: CompactionSnapshot = {
    id: identity(owner, message, ts), status: 'completed', ...owner.activeCompaction, completedAt: ts,
  };
  if (typeof metadata.trigger === 'string') compaction.trigger = metadata.trigger;
  for (const [native, field] of [['pre_tokens', 'preTokens'], ['post_tokens', 'postTokens'], ['duration_ms', 'durationMs']] as const) {
    const value = metadata[native];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) compaction[field] = value;
  }
  if (compaction.durationMs === undefined && compaction.startedAt !== undefined) {
    compaction.durationMs = Math.max(0, ts - compaction.startedAt);
  }
  owner.activeCompaction = undefined;
  emit('message', {
    text: buildClaudeCompactMessageText(compaction), role: 'system', compaction,
    sessionCommandStatus: { command: 'compact', status: 'completed' },
  });
}
