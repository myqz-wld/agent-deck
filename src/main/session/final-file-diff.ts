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
  const fileChanges = changes.filter((c) => normalize(c.filePath) === targetPath);

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

  if (before === after) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'recorded-snapshot',
      reason: 'unchanged',
      message: '记录快照显示该文件最终没有内容变化。',
    };
  }

  const diff = wholeFileUnifiedDiff(targetPath, before, after);
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

function wholeFileUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  return [
    `diff --agent-deck-snapshot a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

function splitDiffLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
