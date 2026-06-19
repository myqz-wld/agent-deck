import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { reverseUnifiedDiffSnapshot } from '@shared/unified-diff';
import { PAYLOAD_LIMITS } from '@main/store/payload-truncate';

const MULTIEDIT_SEPARATOR = '\n---\n';

export interface FileChangeSnapshotInput {
  cwd?: string | null;
  filePath: string;
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
  if (input.kind !== 'text') {
    return { beforeSnapshot: null, afterSnapshot: null };
  }

  const targetPath = resolveSnapshotPath(input.filePath, input.cwd);
  const diskAfter = targetPath ? readTextSnapshot(targetPath) : null;
  const afterSnapshot = diskAfter ?? (isDeleteChange(input.metadata) ? '' : null);
  if (afterSnapshot === null) {
    return { beforeSnapshot: null, afterSnapshot: null };
  }

  return {
    beforeSnapshot: reverseRecordedTextChange(afterSnapshot, input),
    afterSnapshot,
  };
}

function resolveSnapshotPath(filePath: string, cwd?: string | null): string | null {
  const raw = String(filePath || '');
  if (!raw) return null;
  if (isAbsolute(raw)) return normalize(raw);
  if (!cwd) return null;
  return normalize(resolve(cwd, raw));
}

function readTextSnapshot(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
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
  const kind = metadata.changeKind;
  if (kind === 'delete') return true;
  if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
    return (kind as { type?: unknown }).type === 'delete';
  }
  return false;
}

function isAddChange(metadata: Record<string, unknown>): boolean {
  const kind = metadata.changeKind;
  if (typeof kind === 'string') {
    return ['add', 'added', 'new', 'create', 'created'].includes(kind.toLowerCase());
  }
  if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
    const type = (kind as { type?: unknown }).type;
    return (
      typeof type === 'string' &&
      ['add', 'added', 'new', 'create', 'created'].includes(type.toLowerCase())
    );
  }
  return false;
}
