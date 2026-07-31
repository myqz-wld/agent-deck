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
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * 跑 git 子命令拿 stdout。
 *
 * `opts.raw=true` 时不 trim,保留首列 space 与尾部 NUL 让 NUL parser 正确处理（archive
 * `git status --porcelain=v1 -z` 场景；详 archive-plan-impl ArchivePlanDeps.runGit jsdoc）。
 * 默认 raw=false 适合 rev-parse / commit / status --porcelain 等单行 trim 安全场景。
 *
 * 注：archive-plan-impl uses opts.raw, while bounded worktree paths use opts.timeoutMs. Most
 * handler dependency seams still expose a two-argument signature; optional opts keeps them
 * compatible.
 */
export const runGitDefault = async (
  args: readonly string[],
  cwd: string,
  opts?: { raw?: boolean; timeoutMs?: number },
): Promise<string> => {
  const { stdout } = await execFileAsync('git', args as string[], {
    cwd,
    maxBuffer: 1024 * 1024,
    ...(opts?.timeoutMs !== undefined
      ? { timeout: opts.timeoutMs }
      : {}),
  });
  if (opts?.raw) return stdout.toString();
  return stdout.toString().trim();
};

/** 读文件 utf8。失败抛（典型 ENOENT）。 */
export const readFileDefault = async (filePath: string): Promise<string> =>
  fs.readFile(filePath, 'utf8');

/** 写文件 utf8。 */
export const writeFileDefault = async (filePath: string, content: string): Promise<void> =>
  fs.writeFile(filePath, content, 'utf8');

/** 删文件。失败抛。 */
export const unlinkDefault = async (filePath: string): Promise<void> => fs.unlink(filePath);

/** mkdir { recursive: true }。 */
export const mkdirDefault = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

/** mv 目录 (src → dst)，同 fs 用 fs.rename 原子 mv。跨 fs (EXDEV) 抛错让 caller decide。 */
export const mvDirDefault = async (src: string, dst: string): Promise<void> => fs.rename(src, dst);

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

/** realpath 解 symlink，失败抛（caller 决定是否兜底）。 */
export const realpathDefault = async (p: string): Promise<string> => fs.realpath(p);

/**
 * Main-process worktree transition preflights use synchronous metadata syscalls so a saturated
 * libuv filesystem pool cannot strand an MCP request before its first bounded Git command.
 */
export const existsSyncDefault = (p: string): boolean => existsSync(p);

/** Synchronous realpath counterpart for bounded worktree transition preflights. */
export const realpathSyncDefault = (p: string): string => realpathSync.native(p);

/** 当前进程 cwd。 */
export const cwdDefault = (): string => process.cwd();

/** $HOME 路径。 */
export const homedirDefault = (): string => os.homedir();
