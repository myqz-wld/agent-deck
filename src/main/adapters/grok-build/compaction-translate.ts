import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@shared/types';
import { compactionStatus, compactionTitle, type CompactionSnapshot } from '@shared/compaction';

export interface GrokCompactionState {
  status: string;
  startedAt?: number;
  completedAt?: number;
  summary: ContentBlock[];
  error: string | null;
  metadata: Record<string, unknown> | null;
  trigger?: string;
  revision: number;
}
interface Owner {
  compactions: Map<string, GrokCompactionState>;
  compactionObservedForCurrentTurn?: boolean;
  compactionCommandForCurrentTurn?: boolean;
}
type Update = Extract<SessionUpdate, { sessionUpdate: 'compaction_update' | 'compaction_summary_chunk' }>;

/** ACP compaction is an ID-addressed entity: omitted patches retain, null clears, chunks append. */
export function translateGrokCompaction(update: Update, owner: Owner,
  event: (kind: AgentEvent['kind'], payload: unknown) => AgentEvent, ts: number): AgentEvent {
  const previous = owner.compactions.get(update.compactionId);
  const state: GrokCompactionState = previous ? { ...previous, summary: [...previous.summary] }
    : { status: 'in_progress', summary: [], error: null, metadata: null, revision: 0,
      ...(owner.compactionCommandForCurrentTurn ? { trigger: 'manual' } : {}) };
  state.revision += 1;
  if (update.sessionUpdate === 'compaction_update') {
    state.status = update.status;
    if (update.summary !== undefined) state.summary = update.summary ?? [];
    if (update.error !== undefined) state.error = update.error;
    if (update._meta !== undefined) state.metadata = update._meta;
  } else {
    state.summary.push(update.content);
  }
  const status = compactionStatus(state.status);
  if (state.startedAt === undefined && status === 'running') state.startedAt = ts;
  if (status === 'running') state.completedAt = undefined;
  if (status === 'completed' || status === 'failed' || status === 'interrupted') state.completedAt ??= ts;
  owner.compactions.set(update.compactionId, state);
  if (!previous || compactionStatus(previous.status) === 'running') owner.compactionObservedForCurrentTurn = true;
  const compaction: CompactionSnapshot = {
    id: `grok:${update.compactionId}`, status,
    ...(state.trigger ? { trigger: state.trigger } : {}), revision: state.revision,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
    ...(state.completedAt !== undefined && state.startedAt !== undefined
      ? { durationMs: Math.max(0, state.completedAt - state.startedAt) } : {}),
    summary: state.summary.map(contentText).join(''), error: state.error ?? '',
  };
  // Start invalidates context usage once. Later summary patches must not restart activity or usage.
  const kind = status === 'running' && (!previous || compactionStatus(previous.status) !== 'running') ? 'context-compaction-start'
    : status !== 'running' && (!previous || previous.status !== state.status) ? 'context-compaction-end' : 'message';
  return event(kind, {
    role: 'system', text: compactionTitle(status), compaction,
    compactionSummaryOnly: update.sessionUpdate === 'compaction_summary_chunk',
    compactionMetadata: state.metadata,
    imageInputs: state.summary.filter((content) => content.type === 'image'),
  });
}

function contentText(content: ContentBlock): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'image') return '';
  if (content.type === 'resource_link') return `\n${content.title ?? content.name}：${content.uri}\n`;
  if (content.type === 'resource') return 'text' in content.resource
    ? `\n${content.resource.text}\n` : `\n资源：${content.resource.uri}\n`;
  return '\n（摘要包含音频内容）\n';
}
