import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FileChangeRecord, FileFinalDiffResult } from '@shared/types';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { sessionRepo } from '@main/store/session-repo';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BUFFER = 4 * 1024 * 1024;
const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
const MULTIEDIT_SEPARATOR = '\n---\n';

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
      source: 'git',
      reason: 'not_in_session',
      message: '该文件不属于当前会话记录的改动。',
    };
  }

  const root = await gitRoot(session.cwd);
  if (!root) {
    return fallbackFinalDiff(
      targetPath,
      fileChanges,
      '当前会话目录不是 Git 仓库，且会话记录不足以还原最终 diff。',
    );
  }

  const rel = relative(root, targetPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return fallbackFinalDiff(
      targetPath,
      fileChanges,
      '该文件不在当前 Git 仓库内，且会话记录不足以还原最终 diff。',
    );
  }

  const gitPath = rel.split(sep).join('/');
  const tracked = await git(['ls-files', '--error-unmatch', '--', gitPath], root);
  const diff =
    !tracked.ok && existsSync(targetPath)
      ? await gitNoIndexNewFile(targetPath, root)
      : await git(['diff', '--no-ext-diff', 'HEAD', '--', gitPath], root);

  if (diff.tooLarge) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'git',
      reason: 'too_large',
      message: '最终 diff 过大，超过当前可显示上限。',
    };
  }
  if (!diff.ok) {
    const fallback = fallbackFinalDiff(
      targetPath,
      fileChanges,
      diff.stderr || diff.error || '计算最终 diff 失败，且会话记录不足以还原。',
    );
    if (fallback.ok) return fallback;
    return fallback;
  }
  if (!diff.stdout.trim()) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'git',
      reason: 'unchanged',
      message: '当前文件相对 HEAD 没有可显示的最终 diff。',
    };
  }
  return { ok: true, filePath: targetPath, diff: diff.stdout, source: 'git' };
}

function fallbackFinalDiff(
  targetPath: string,
  fileChanges: FileChangeRecord[],
  failureMessage: string,
): FileFinalDiffResult {
  const snapshot = snapshotFallbackDiff(targetPath, fileChanges);
  if (snapshot) {
    return {
      ok: true,
      filePath: targetPath,
      diff: snapshot,
      source: 'snapshot-fallback',
    };
  }

  const recorded = recordedPatchFallback(fileChanges);
  if (recorded) {
    return {
      ok: true,
      filePath: targetPath,
      diff: recorded,
      source: 'recorded-patch-fallback',
    };
  }

  return {
    ok: false,
    filePath: targetPath,
    diff: null,
    source: 'snapshot-fallback',
    reason: 'not_git_repo',
    message: failureMessage,
  };
}

function snapshotFallbackDiff(
  targetPath: string,
  fileChanges: FileChangeRecord[],
): string | null {
  if (!existsSync(targetPath)) return null;
  const stat = statSync(targetPath);
  if (!stat.isFile() || stat.size > MAX_FALLBACK_FILE_BYTES) return null;
  let current = readFileSync(targetPath, 'utf8');
  const final = current;
  const ordered = [...fileChanges].sort((a, b) => a.ts - b.ts || a.id - b.id);
  if (ordered.some((c) => c.kind !== 'text')) return null;

  for (const change of [...ordered].reverse()) {
    const reversed = reverseTextChange(current, change);
    if (reversed === null) return null;
    current = reversed;
  }

  if (current === final) return null;
  return wholeFileUnifiedDiff(targetPath, current, final);
}

function reverseTextChange(content: string, change: FileChangeRecord): string | null {
  const source = typeof change.metadata?.source === 'string' ? change.metadata.source : '';
  if (source === 'MultiEdit' && change.beforeBlob !== null && change.afterBlob !== null) {
    const beforeParts = change.beforeBlob.split(MULTIEDIT_SEPARATOR);
    const afterParts = change.afterBlob.split(MULTIEDIT_SEPARATOR);
    if (beforeParts.length !== afterParts.length) return null;
    let next = content;
    for (let i = afterParts.length - 1; i >= 0; i -= 1) {
      const reversed = replaceLast(next, afterParts[i], beforeParts[i]);
      if (reversed === null) return null;
      next = reversed;
    }
    return next;
  }

  if (source === 'Write' && change.afterBlob !== null) {
    if (content !== change.afterBlob) return null;
    return change.beforeBlob ?? '';
  }

  if (change.afterBlob === null) return null;
  return replaceLast(content, change.afterBlob, change.beforeBlob ?? '');
}

function replaceLast(content: string, needle: string, replacement: string): string | null {
  if (needle.length === 0) return content === needle ? replacement : null;
  const index = content.lastIndexOf(needle);
  if (index < 0) return null;
  return `${content.slice(0, index)}${replacement}${content.slice(index + needle.length)}`;
}

function recordedPatchFallback(fileChanges: FileChangeRecord[]): string | null {
  const diffs = [...fileChanges]
    .sort((a, b) => a.ts - b.ts || a.id - b.id)
    .map((c) => (typeof c.metadata?.diff === 'string' ? c.metadata.diff : ''))
    .filter((diff) => diff.trim());
  if (diffs.length === 0) return null;
  return diffs.join('\n\n');
}

function wholeFileUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  return [
    `diff --agent-deck-fallback a/${filePath} b/${filePath}`,
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

async function gitRoot(cwd: string): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], cwd);
  return result.ok ? result.stdout.trim() || null : null;
}

async function gitNoIndexNewFile(
  targetPath: string,
  cwd: string,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  tooLarge?: boolean;
}> {
  const result = await git(
    ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', targetPath],
    cwd,
  );
  return result.exitCode === 1 && result.stdout ? { ...result, ok: true } : result;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
  tooLarge?: boolean;
}> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_DIFF_BUFFER,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      error: e.message,
      exitCode: typeof e.code === 'number' ? e.code : undefined,
      tooLarge: /maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/i.test(e.message),
    };
  }
}
