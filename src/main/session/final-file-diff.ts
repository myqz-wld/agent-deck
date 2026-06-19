import { isAbsolute, normalize, resolve } from 'node:path';
import type { FileChangeRecord, FileFinalDiffResult } from '@shared/types';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { sessionRepo } from '@main/store/session-repo';

const MAX_RECORDED_DIFF_BYTES = 4 * 1024 * 1024;

export async function getSessionFileFinalDiff(
  sessionId: string,
  filePath: string,
): Promise<FileFinalDiffResult> {
  const session = sessionRepo.get(sessionId);
  const inputPath = String(filePath || '');
  const targetPath = normalize(
    isAbsolute(inputPath) ? inputPath : resolve(session?.cwd ?? '', inputPath),
  );

  const changes = session ? fileChangeRepo.listForSession(sessionId) : [];
  const fileChanges = changes.filter(
    (c) => normalizeFilePath(c.filePath, session?.cwd ?? '') === targetPath,
  );

  if (!session || fileChanges.length === 0) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'recorded-snapshot',
      reason: 'not_in_session',
      message: '该文件不属于当前会话记录的改动。',
    };
  }

  const snapshot = snapshotFinalDiff(targetPath, fileChanges);
  if (snapshot) return snapshot;

  const recorded = recordedPatchFallback(targetPath, fileChanges);
  if (recorded) return recorded;

  return {
    ok: false,
    filePath: targetPath,
    diff: null,
    source: 'recorded-snapshot',
    reason: 'snapshot_unavailable',
    message: '该文件没有可用的记录快照，无法还原最终 diff。',
  };
}

function normalizeFilePath(filePath: string, cwd: string): string {
  const raw = String(filePath || '');
  return normalize(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

function snapshotFinalDiff(
  targetPath: string,
  fileChanges: FileChangeRecord[],
): FileFinalDiffResult | null {
  const ordered = [...fileChanges].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const before = first.beforeSnapshot;
  const after = last.afterSnapshot;
  if (before == null || after == null) return null;
  const finalFileKind = inferFinalFileKind(first, last);

  if (before === after && finalFileKind === null) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'recorded-snapshot',
      reason: 'unchanged',
      message: '记录快照显示该文件最终没有内容变化。',
    };
  }

  const diff = wholeFileUnifiedDiff(targetPath, before, after, finalFileKind);
  if (Buffer.byteLength(diff, 'utf8') > MAX_RECORDED_DIFF_BYTES) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'recorded-snapshot',
      reason: 'too_large',
      message: '记录快照生成的最终 diff 过大，超过当前可显示上限。',
    };
  }

  return { ok: true, filePath: targetPath, diff, source: 'recorded-snapshot' };
}

type FinalFileKind = 'added' | 'deleted' | null;

function inferFinalFileKind(first: FileChangeRecord, last: FileChangeRecord): FinalFileKind {
  const firstIsAdd = isAddChange(first);
  const lastIsDelete = isDeleteChange(last);
  if (firstIsAdd && lastIsDelete) return null;
  if (firstIsAdd) return 'added';
  if (lastIsDelete) return 'deleted';
  return null;
}

function isAddChange(change: FileChangeRecord): boolean {
  const changeKind = readChangeKind(change.metadata);
  if (['add', 'added', 'new', 'create', 'created'].includes(changeKind ?? '')) return true;
  if (hasNewFileDiffHeader(change.metadata)) return true;
  return change.metadata?.source === 'Write' && change.beforeBlob == null;
}

function isDeleteChange(change: FileChangeRecord): boolean {
  const changeKind = readChangeKind(change.metadata);
  if (['delete', 'deleted', 'remove', 'removed'].includes(changeKind ?? '')) return true;
  return hasDeletedFileDiffHeader(change.metadata);
}

function readChangeKind(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.changeKind;
  if (typeof raw === 'string' && raw) return raw.toLowerCase();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const type = (raw as { type?: unknown }).type;
    return typeof type === 'string' && type ? type.toLowerCase() : null;
  }
  return null;
}

function hasNewFileDiffHeader(metadata: Record<string, unknown> | undefined): boolean {
  const diff = typeof metadata?.diff === 'string' ? metadata.diff : '';
  return /^(new file mode |--- \/dev\/null$)/m.test(diff);
}

function hasDeletedFileDiffHeader(metadata: Record<string, unknown> | undefined): boolean {
  const diff = typeof metadata?.diff === 'string' ? metadata.diff : '';
  return /^(deleted file mode |\+\+\+ \/dev\/null$)/m.test(diff);
}

function recordedPatchFallback(
  targetPath: string,
  fileChanges: FileChangeRecord[],
): FileFinalDiffResult | null {
  const diffs = [...fileChanges]
    .sort((a, b) => a.ts - b.ts || a.id - b.id)
    .map((c) => (typeof c.metadata?.diff === 'string' ? c.metadata.diff : ''))
    .filter((diff) => diff.trim());
  if (diffs.length === 0) return null;

  const diff = diffs.join('\n\n');
  if (Buffer.byteLength(diff, 'utf8') > MAX_RECORDED_DIFF_BYTES) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'recorded-patch-fallback',
      reason: 'too_large',
      message: '会话记录中的 patch 过大，超过当前可显示上限。',
    };
  }

  return {
    ok: true,
    filePath: targetPath,
    diff,
    source: 'recorded-patch-fallback',
  };
}

function wholeFileUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  finalFileKind: FinalFileKind,
): string {
  const beforeLines = finalFileKind === 'added' ? [] : splitDiffLines(before);
  const afterLines = finalFileKind === 'deleted' ? [] : splitDiffLines(after);
  const beforePath = finalFileKind === 'added' ? '/dev/null' : `a/${filePath}`;
  const afterPath = finalFileKind === 'deleted' ? '/dev/null' : `b/${filePath}`;
  const beforeStart = beforeLines.length === 0 ? 0 : 1;
  const afterStart = afterLines.length === 0 ? 0 : 1;
  return [
    `diff --agent-deck-snapshot a/${filePath} b/${filePath}`,
    ...(finalFileKind === 'added' ? ['new file mode 100644'] : []),
    ...(finalFileKind === 'deleted' ? ['deleted file mode 100644'] : []),
    `--- ${beforePath}`,
    `+++ ${afterPath}`,
    `@@ -${beforeStart},${beforeLines.length} +${afterStart},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

function splitDiffLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
