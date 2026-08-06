import type { AgentEvent } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import {
  imageResultToFileChanges,
  parseImageToolResult,
} from '@main/adapters/claude-code/translate';
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

/** Consume every tool-name lookup and project successful image results into file changes. */
export function maybeEmitImageFileChangedCore(
  emit: EmitTranslatedEvent,
  internal: InternalSession,
  toolUseId: string | undefined,
  content: unknown,
  status: 'completed' | 'failed' = 'completed',
): void {
  if (!toolUseId) return;
  const toolName = internal.toolUseNames.get(toolUseId);
  internal.toolUseNames.delete(toolUseId);
  if (status === 'failed' || !isImageTool(toolName)) return;
  const parsed = parseImageToolResult(content);
  if (!parsed) return;
  for (const fileChange of imageResultToFileChanges(parsed, toolUseId)) {
    emit('file-changed', fileChange);
  }
}
