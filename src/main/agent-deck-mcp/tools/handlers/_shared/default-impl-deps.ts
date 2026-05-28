/**
 * 4 个 mcp tool impl 文件（archive-plan-impl / hand-off-session-impl /
 * enter-worktree-impl / exit-worktree-impl）共用的 DEFAULT_DEPS 字段实现。
 *
 * **修法动机**（CHANGELOG_169 F9）：4 处定义同款 runGit / readFile / exists / cwd /
 * homedir / realpath 等 fs/process default helper，违反 user CLAUDE.md 提示词资产维护
 * §约束 1「多处出现同款规则抽到一处其他位置引用」。如默认行为变更（如 fs.stat → fs.access
 * / mkdir 加 mode 参数），单点维护即可一致生效，避免 4 处同步改易遗漏。
 *
 * **使用方式**：每个 default helper 单独 export，各 impl 文件按需 `import { ... }` 取用，
 * 拼到自己的 DEFAULT_DEPS 对象里。共用核心是「行为单点」，不是「减少 LOC」。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * 跑 git 子命令拿 stdout。
 *
 * `opts.raw=true` 时不 trim,保留首列 space 与尾部 NUL 让 NUL parser 正确处理（archive
 * `git status --porcelain=v1 -z` 场景；详 archive-plan-impl ArchivePlanDeps.runGit jsdoc）。
 * 默认 raw=false 适合 rev-parse / commit / status --porcelain 等单行 trim 安全场景。
 *
 * 注：archive-plan-impl 用 3 参签名（含 opts.raw），hand-off / enter / exit 用 2 参签名
 * （没有 opts），TS 兼容性靠 opts 可选 + 各 caller 类型签名独立约束。
 */
export const runGitDefault = async (
  args: readonly string[],
  cwd: string,
  opts?: { raw?: boolean },
): Promise<string> => {
  const { stdout } = await execFileAsync('git', args as string[], { cwd, maxBuffer: 1024 * 1024 });
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

/** 当前进程 cwd。 */
export const cwdDefault = (): string => process.cwd();

/** $HOME 路径。 */
export const homedirDefault = (): string => os.homedir();
