import { reverseUnifiedDiffSnapshot } from '@shared/unified-diff';

const MULTIEDIT_SEPARATOR = '\n---\n';

export interface FileChangeSnapshotInput {
  captureAuthorized: boolean;
  capturedAfterSnapshot: string | null;
  kind: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
}

export interface FileChangeSnapshots {
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
}

export function buildFileChangeSnapshots(input: FileChangeSnapshotInput): FileChangeSnapshots {
  if (input.kind !== 'text' || !input.captureAuthorized) {
    return { beforeSnapshot: null, afterSnapshot: null };
  }

  const afterSnapshot = input.capturedAfterSnapshot ??
    (isDeleteChange(input.metadata) ? '' : null);
  if (afterSnapshot === null) {
    return { beforeSnapshot: null, afterSnapshot: null };
  }

  return {
    beforeSnapshot: reverseRecordedTextChange(afterSnapshot, input),
    afterSnapshot,
  };
}

function reverseRecordedTextChange(
  afterSnapshot: string,
  input: FileChangeSnapshotInput,
): string | null {
  const diff = typeof input.metadata.diff === 'string' ? input.metadata.diff : null;
  if (diff && diff.trim()) {
    const reversed = reverseUnifiedDiffSnapshot(afterSnapshot, diff);
    if (reversed !== null) return reversed;
  }
  if (isAddChange(input.metadata)) return '';

  const source = typeof input.metadata.source === 'string' ? input.metadata.source : '';
  const before = typeof input.before === 'string' ? input.before : null;
  const after = typeof input.after === 'string' ? input.after : null;

  if (source === 'MultiEdit' && before !== null && after !== null) {
    const beforeParts = before.split(MULTIEDIT_SEPARATOR);
    const afterParts = after.split(MULTIEDIT_SEPARATOR);
    if (beforeParts.length !== afterParts.length) return null;
    let next = afterSnapshot;
    for (let i = afterParts.length - 1; i >= 0; i -= 1) {
      const reversed = replaceLast(next, afterParts[i], beforeParts[i]);
      if (reversed === null) return null;
      next = reversed;
    }
    return next;
  }

  if (source === 'Write' && after !== null) {
    if (afterSnapshot !== after) return null;
    return before ?? '';
  }

  if (after === null) return null;
  return replaceLast(afterSnapshot, after, before ?? '');
}

function replaceLast(content: string, needle: string, replacement: string): string | null {
  if (needle.length === 0) return content === needle ? replacement : null;
  const index = content.lastIndexOf(needle);
  if (index < 0) return null;
  return `${content.slice(0, index)}${replacement}${content.slice(index + needle.length)}`;
}

function isDeleteChange(metadata: Record<string, unknown>): boolean {
  return metadata.changeKind === 'delete';
}

function isAddChange(metadata: Record<string, unknown>): boolean {
  const kind = metadata.changeKind;
  if (typeof kind === 'string') {
    return ['add', 'added', 'new', 'create', 'created'].includes(kind.toLowerCase());
  }
  return false;
}
