/**
 * Shared DEFAULT_DEPS helpers for MCP handlers that need git, fs, cwd, home,
 * and realpath operations. Each handler imports only the helpers it uses.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  promises as fs,
  realpathSync,
  type Stats,
} from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * 跑 git 子命令拿 stdout。
 *
 * Worktree lifecycle callers may provide a timeout for bounded preflight or mutation commands.
 * Output is trimmed because all current consumers expect a single value or ordinary status text.
 */
export const runGitDefault = async (
  args: readonly string[],
  cwd: string,
  opts?: { timeoutMs?: number },
): Promise<string> => {
  const { stdout } = await execFileAsync('git', args as string[], {
    cwd,
    maxBuffer: 1024 * 1024,
    ...(opts?.timeoutMs !== undefined
      ? { timeout: opts.timeoutMs }
      : {}),
  });
  return stdout.toString().trim();
};

/** mkdir { recursive: true }。 */
export const mkdirDefault = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

/** 文件 / 目录是否存在（true / false，不抛）。 */
export const existsDefault = async (p: string): Promise<boolean> => {
  try {
    const _: Stats = await fs.stat(p);
    void _;
    return true;
  } catch {
    return false;
  }
};

/**
 * Main-process worktree transition preflights use synchronous metadata syscalls so a saturated
 * libuv filesystem pool cannot strand an MCP request before its first bounded Git command.
 */
export const existsSyncDefault = (p: string): boolean => existsSync(p);

/** Synchronous realpath counterpart for bounded worktree transition preflights. */
export const realpathSyncDefault = (p: string): string => realpathSync.native(p);
