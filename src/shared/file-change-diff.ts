import type { AgentEvent, DiffPayload, FileChangePayload } from './types';
import { reconstructUnifiedDiffSnapshots } from './unified-diff';

/** Use complete snapshot pairs, never a snippet on one side and a full file on the other. */
export function fileChangeToDiff(change: FileChangePayload): DiffPayload {
  const snapshots = change.kind === 'text'
    && change.beforeSnapshot != null && change.afterSnapshot != null;
  return {
    kind: change.kind,
    filePath: change.filePath,
    before: decodeFileChangeBlob(change.kind, snapshots ? change.beforeSnapshot! : change.beforeBlob),
    after: decodeFileChangeBlob(change.kind, snapshots ? change.afterSnapshot! : change.afterBlob),
    metadata: change.metadata,
    toolCallId: change.toolCallId ?? undefined,
    ts: change.ts,
  };
}

export function decodeFileChangeBlob(kind: string, blob: string | null): unknown {
  if (blob == null) return null;
  if (kind !== 'image') return blob;
  try { return JSON.parse(blob); } catch { return null; }
}

/** Old activity rows already carry content; no path lookup or workspace read is needed. */
export function fileChangeEventToDiff(event: AgentEvent): DiffPayload | null {
  const p = event.payload as Partial<DiffPayload> | null;
  if (event.kind !== 'file-changed' || typeof p?.filePath !== 'string') return null;
  return {
    kind: typeof p.kind === 'string' ? p.kind : 'text',
    filePath: p.filePath,
    before: p.before ?? null,
    after: p.after ?? null,
    metadata: p.metadata,
    toolCallId: p.toolCallId,
    ts: event.ts,
  };
}

export type TextChangeKind = 'added' | 'deleted' | 'modified';
export interface TextDiffModel {
  change: TextChangeKind;
  before: string | null;
  after: string | null;
  /** Unparseable patches remain readable, without pretending to be file content. */
  patch: string | null;
}

function explicitChange(value: unknown): TextChangeKind | null {
  if (typeof value !== 'string') return null;
  const kind = value.toLowerCase();
  if (['add', 'added', 'new', 'create', 'created'].includes(kind)) return 'added';
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'deleted';
  if (['update', 'modify', 'modified', 'edit', 'change', 'rename', 'move'].includes(kind)) return 'modified';
  return null;
}

export function normalizeTextDiff(payload: DiffPayload): TextDiffModel {
  const md = payload.metadata ?? {};
  let before = typeof payload.before === 'string' ? payload.before : null;
  let after = typeof payload.after === 'string' ? payload.after : null;
  const diff = typeof md.diff === 'string' ? md.diff : null;
  let change = explicitChange(md.changeKind)
    ?? (md.source === 'Edit' || md.source === 'MultiEdit' ? 'modified' : null);
  if (before !== null || after !== null) {
    change ??= before === null || before === '' ? 'added'
      : after === null || after === '' ? 'deleted' : 'modified';
    return { change, before, after, patch: null };
  }
  if (diff !== null) {
    // A newly created Markdown/code file may itself contain patch examples further down.
    // Only treat Codex whole-file content as a patch when it starts with patch syntax.
    const patchSyntax = /^(diff --git |@@ -\d|--- |\+\+\+ |new file mode |deleted file mode |Binary files |GIT binary patch)/.test(diff.trimStart());
    if (md.source === 'codex' && (change === 'added' || change === 'deleted') && !patchSyntax) {
      return { change, before: change === 'deleted' ? diff : '', after: change === 'added' ? diff : '', patch: null };
    }
    change ??= /^(new file mode |--- \/dev\/null\r?$)/m.test(diff) ? 'added'
      : /^(deleted file mode |\+\+\+ \/dev\/null\r?$)/m.test(diff) ? 'deleted' : null;
    const reconstructed = reconstructUnifiedDiffSnapshots(diff);
    if (reconstructed) {
      return { change: change ?? 'modified', ...reconstructed, patch: null };
    }
  }
  return { change: change ?? 'modified', before, after, patch: diff?.trim() ? diff : null };
}
