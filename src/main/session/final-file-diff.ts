import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FileFinalDiffResult } from '@shared/types';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { sessionRepo } from '@main/store/session-repo';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BUFFER = 4 * 1024 * 1024;

export async function getSessionFileFinalDiff(
  sessionId: string,
  filePath: string,
): Promise<FileFinalDiffResult> {
  const session = sessionRepo.get(sessionId);
  const inputPath = String(filePath || '');
  const targetPath = normalize(
    isAbsolute(inputPath) ? inputPath : resolve(session?.cwd ?? '', inputPath),
  );

  if (
    !session ||
    !fileChangeRepo.listForSession(sessionId).some((c) => normalize(c.filePath) === targetPath)
  ) {
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
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'git',
      reason: 'not_git_repo',
      message: '当前会话目录不是 Git 仓库，无法计算最终 diff。',
    };
  }

  const rel = relative(root, targetPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'git',
      reason: 'outside_repo',
      message: '该文件不在当前 Git 仓库内，无法计算最终 diff。',
    };
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
    return {
      ok: false,
      filePath: targetPath,
      diff: null,
      source: 'git',
      reason: 'git_error',
      message: diff.stderr || diff.error || '计算最终 diff 失败。',
    };
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
