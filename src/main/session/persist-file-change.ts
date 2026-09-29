import type { AgentEvent } from '@shared/types';
import { withStoredFileChangePathAuthority } from '@shared/file-change-path-authority';
import { sessionRepo } from '@main/store/session-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { buildFileChangeSnapshots } from './file-change-snapshots';
import { captureFileChangePath } from './file-change-path-authority';

/** Persist content once; activity records carry a session-bound reference for lazy reading. */
export function persistFileChange(event: AgentEvent): AgentEvent {
  if (event.kind !== 'file-changed') return event;
  const p = event.payload as {
    filePath?: string;
    kind?: string;
    before?: unknown;
    after?: unknown;
    toolCallId?: string;
    metadata?: Record<string, unknown>;
    cwd?: string;
  };
  if (!p || typeof p.filePath !== 'string') return event;
  // text 通道 before/after 是 string，原样存；image 通道是 ImageSource 对象，需 JSON.stringify。
  // file_changes.before_blob / after_blob 列是 TEXT，序列化后存得下（典型 < 200 chars）。
  const serialize = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  };
  const kind = typeof p.kind === 'string' ? p.kind : 'text';
  const sourceMetadata =
    p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
      ? p.metadata
      : {};
  const cwd = typeof p.cwd === 'string' ? p.cwd : sessionRepo.get(event.sessionId)?.cwd ?? null;
  const captured = captureFileChangePath(cwd, p.filePath, kind === 'text');
  const metadata = withStoredFileChangePathAuthority(sourceMetadata, captured.authority);
  const snapshots = buildFileChangeSnapshots({
    captureAuthorized: captured.authority !== null,
    capturedAfterSnapshot: captured.afterSnapshot,
    kind,
    before: p.before,
    after: p.after,
    metadata,
  });
  const fileChangeId = fileChangeRepo.insert({
    sessionId: event.sessionId,
    filePath: p.filePath,
    kind,
    beforeBlob: serialize(p.before),
    afterBlob: serialize(p.after),
    beforeSnapshot: snapshots.beforeSnapshot,
    afterSnapshot: snapshots.afterSnapshot,
    metadata,
    toolCallId: p.toolCallId ?? null,
    ts: event.ts,
  });
  return {
    ...event,
    payload: {
      fileChangeId,
      filePath: p.filePath,
      kind,
      toolCallId: p.toolCallId,
      metadata: {
        source: sourceMetadata.source,
        changeKind: sourceMetadata.changeKind,
        patchStatus: sourceMetadata.patchStatus,
      },
    },
  };
}
