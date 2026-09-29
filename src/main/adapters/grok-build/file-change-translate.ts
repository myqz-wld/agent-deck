import type { ToolCallContent, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@shared/types';

type DiffContent = Extract<ToolCallContent, { type: 'diff' }>;
export interface GrokFileChanges {
  pending: Map<string, Map<string, DiffContent>>;
  completed: Map<string, { status: 'completed' | 'failed'; paths: Set<string> }>;
}

/** ACP can attach diffs to the initial call or a progress update, before completion. */
export function collectGrokFileChanges(
  update: ToolCall | ToolCallUpdate,
  state: GrokFileChanges,
  cwd: string,
  event: (kind: AgentEvent['kind'], payload: unknown) => AgentEvent,
): AgentEvent[] {
  const id = update.toolCallId;
  const previous = state.completed.get(id);
  if (previous?.status === 'failed') return [];
  let changes = state.pending.get(id);
  for (const content of update.content ?? []) {
    if (content.type !== 'diff' || previous?.paths.has(content.path)) continue;
    changes ??= new Map();
    const first = changes.get(content.path);
    changes.set(content.path, first ? { ...content, oldText: first.oldText } : content);
  }
  if (changes) state.pending.set(id, changes);
  const status = previous?.status ?? update.status;
  if (status !== 'completed' && status !== 'failed') return [];
  state.pending.delete(id);
  const paths = previous?.paths ?? new Set<string>();
  for (const path of changes?.keys() ?? []) paths.add(path);
  state.completed.set(id, { status, paths });
  if (state.completed.size > 256) state.completed.delete(state.completed.keys().next().value!);
  if (status === 'failed') return [];
  return [...(changes?.values() ?? [])].map((content) => event('file-changed', {
    cwd,
    filePath: content.path,
    kind: 'text',
    before: content.oldText ?? null,
    after: content.newText,
    metadata: { source: 'grok-acp', changeKind: content.oldText == null ? 'add' : 'update' },
    toolCallId: id,
  }));
}
