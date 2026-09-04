import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';

type EmitTranslatedEvent = (kind: AgentEvent['kind'], payload: unknown) => void;

/** Queue Edit/Write/MultiEdit intent until the authoritative tool result arrives. */
export function pushFileChangeIntentCore(
  internal: InternalSession,
  toolName: string | undefined,
  input: unknown,
  toolUseId: string | undefined,
): void {
  if (!toolName || !toolUseId) return;
  const parsed = (input ?? {}) as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
  };
  let payload: Record<string, unknown> | null = null;
  if (toolName === 'Edit' && parsed.file_path) {
    payload = {
      filePath: parsed.file_path,
      kind: 'text',
      before: parsed.old_string ?? null,
      after: parsed.new_string ?? null,
      metadata: { source: 'Edit' },
      toolCallId: toolUseId,
    };
  } else if (toolName === 'Write' && parsed.file_path) {
    payload = {
      filePath: parsed.file_path,
      kind: 'text',
      before: null,
      after: parsed.content ?? null,
      metadata: { source: 'Write' },
      toolCallId: toolUseId,
    };
  } else if (
    toolName === 'MultiEdit' &&
    parsed.file_path &&
    Array.isArray(parsed.edits)
  ) {
    payload = {
      filePath: parsed.file_path,
      kind: 'text',
      before: parsed.edits.map((edit) => edit.old_string).join('\n---\n'),
      after: parsed.edits.map((edit) => edit.new_string).join('\n---\n'),
      metadata: { source: 'MultiEdit', editCount: parsed.edits.length },
      toolCallId: toolUseId,
    };
  }
  if (payload) internal.pendingFileChangeIntents.set(toolUseId, payload);
}

/** Consume a text intent exactly once; failed tools delete without emitting dirty state. */
export function consumePendingFileChangeIntentCore(
  emit: EmitTranslatedEvent,
  internal: InternalSession,
  toolUseId: string | undefined,
  status: 'completed' | 'failed',
): void {
  if (!toolUseId) return;
  const intent = internal.pendingFileChangeIntents.get(toolUseId);
  if (!intent) return;
  internal.pendingFileChangeIntents.delete(toolUseId);
  if (status === 'completed') emit('file-changed', intent);
}
