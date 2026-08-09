import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { parseWorkspaceDirectoryRef } from '@contracts/index';
import { runGitDefault } from '@main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps';
import {
  ServerCoreWorktreeCleanupUnprovedError,
  ServerCoreWorktreeError,
} from './mcp-worktree-port';
import {
  createServerCorePinnedDirectory,
  createServerCorePinnedWorktree,
  ServerCorePinnedMutationError,
  type ServerCorePinnedDirectoryCreator,
  type ServerCorePinnedWorktreeCreator,
} from './mcp-worktree-pinned-create';
import {
  serverCoreWorktreeReferenceFence,
  type ServerCoreWorktreeReferenceLease,
} from './worktree-reference-fence';

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_CHECK_TIMEOUT_MS = 30_000;
const GIT_MUTATION_TIMEOUT_MS = 10 * 60_000;
const PARENT_MUTATION_TIMEOUT_MS = 30_000;

type GitRunner = (
  args: readonly string[],
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<string>;

export interface ServerCorePreparedWorktree {
  readonly originalCwd: string;
  readonly mainRepo: string;
  readonly gitCommonDir: string;
  readonly worktreePath: string;
  readonly relativeWorktreePath: string;
  readonly startCommit: string;
  readonly mutationLease: ServerCoreWorktreeReferenceLease;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly gitCommonIdentity: { readonly dev: number; readonly ino: number };
}

export interface ServerCoreWorktreePathsOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly runGit?: GitRunner;
  readonly createDirectory?: ServerCorePinnedDirectoryCreator;
  readonly createWorktree?: ServerCorePinnedWorktreeCreator;
  readonly now?: () => number;
}

function sameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function startPoint(value: string): string {
  if (
    value.trim() !== value || value.length === 0 || value.startsWith('-') ||
    /[\s\u0000]/u.test(value) || new TextEncoder().encode(value).byteLength > 1_024
  ) {
    throw new ServerCoreWorktreeError(
      'startPoint 必须是一个有效的 Git revision',
      '请使用 HEAD、分支、标签、远端跟踪分支或单个 revision 表达式。',
    );
  }
  return value;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'session';
}

/** Owns Git/path mutation while keeping every public path Workspace-relative. */
export class ServerCoreWorktreePaths {
  private readonly workspaceRoot: string;
  private readonly privateRoots: readonly string[];
  private readonly runGit: GitRunner;
  private readonly createDirectory: ServerCorePinnedDirectoryCreator;
  private readonly createWorktree: ServerCorePinnedWorktreeCreator;
  private readonly now: () => number;

  private constructor(options: ServerCoreWorktreePathsOptions, workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.privateRoots = options.privateRoots.map((root) => path.resolve(root));
    this.runGit = options.runGit ?? runGitDefault;
    this.createDirectory = options.createDirectory ?? createServerCorePinnedDirectory;
    this.createWorktree = options.createWorktree ?? createServerCorePinnedWorktree;
    this.now = options.now ?? Date.now;
  }

  static async create(
    options: ServerCoreWorktreePathsOptions,
  ): Promise<ServerCoreWorktreePaths> {
    const workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
    return new ServerCoreWorktreePaths(options, workspaceRoot);
  }

  toRelative(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    this.assertWorkspacePath(resolved, 'worktree path');
    const relative = path.relative(this.workspaceRoot, resolved);
    return parseWorkspaceDirectoryRef(
      relative === '' ? '.' : relative.split(path.sep).join('/'),
      'worktreePath',
    );
  }

  async prepareEnter(input: {
    readonly sessionId: string;
    readonly callerCwd: string;
    readonly startPoint: string;
    readonly worktreePath?: string;
    readonly worktreeRoot?: string;
  }): Promise<ServerCorePreparedWorktree> {
    const requestedStartPoint = startPoint(input.startPoint);
    const relativePath = input.worktreePath === undefined
      ? undefined
      : parseWorkspaceDirectoryRef(input.worktreePath, 'worktreePath');
    const relativeRoot = input.worktreeRoot === undefined
      ? undefined
      : parseWorkspaceDirectoryRef(input.worktreeRoot, 'worktreeRoot');
    const originalCwd = await this.canonicalExisting(input.callerCwd, 'session cwd');
    const repository = await this.resolveRepository(originalCwd);
    const { mainRepo } = repository;
    const commit = await this.resolveCommit(requestedStartPoint, mainRepo);
    const defaultRoot = path.join(mainRepo, '.agent-deck', 'worktrees');
    const requestedRoot = relativeRoot === undefined
      ? defaultRoot
      : this.resolveRelative(relativeRoot);
    const requestedPath = relativePath === undefined
      ? path.join(
          requestedRoot,
          `agent-deck-${slug(input.sessionId.slice(0, 16))}-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        )
      : this.resolveRelative(relativePath);
    this.assertWorkspacePath(requestedRoot, 'worktree root');
    this.assertWorkspacePath(requestedPath, 'worktree path');
    if (relativePath !== undefined && relativeRoot !== undefined &&
        !sameOrInside(requestedPath, requestedRoot)) {
      throw new ServerCoreWorktreeError(
        'worktreePath 不在指定的 worktreeRoot 内',
        '请传入同一 Workspace 下的相对路径，或省略其中一个参数。',
      );
    }
    if (relativePath === undefined && relativeRoot === undefined) {
      await this.assertDefaultRootIgnored(mainRepo);
    }
    let mutationLease: ServerCoreWorktreeReferenceLease;
    try {
      mutationLease = serverCoreWorktreeReferenceFence.acquireMutation(requestedPath);
    } catch {
      throw new ServerCoreWorktreeError(
        'worktree 路径正在被另一个生命周期操作使用',
        '请等待相关 worktree 创建或清理完成后再试。',
      );
    }
    try {
      const canonicalParent = await this.createCanonicalParent(path.dirname(requestedPath));
      const parentIdentity = await this.canonicalParentIdentity(canonicalParent);
      const worktreePath = path.join(canonicalParent, path.basename(requestedPath));
      if (await exists(worktreePath)) {
        throw new ServerCoreWorktreeError(
          '目标 worktree 目录已经存在',
          '请选择新的 Workspace 相对路径，或省略路径让 Core 自动生成。',
        );
      }
      return {
        originalCwd,
        mainRepo,
        gitCommonDir: repository.gitCommonDir,
        worktreePath,
        relativeWorktreePath: this.toRelative(worktreePath),
        startCommit: commit,
        mutationLease,
        parentIdentity,
        gitCommonIdentity: repository.gitCommonIdentity,
      };
    } catch (error) {
      mutationLease.release();
      throw error;
    }
  }

  async createPrepared(prepared: ServerCorePreparedWorktree): Promise<void> {
    const parent = path.dirname(prepared.worktreePath);
    let mutationAttempted = false;
    try {
      await this.canonicalParentIdentity(parent, prepared.parentIdentity);
      mutationAttempted = true;
      await this.createWorktree({
        parent,
        parentIdentity: prepared.parentIdentity,
        gitCommonDir: prepared.gitCommonDir,
        gitCommonIdentity: prepared.gitCommonIdentity,
        worktreeName: path.basename(prepared.worktreePath),
        startCommit: prepared.startCommit,
        timeoutMs: GIT_MUTATION_TIMEOUT_MS,
      });
      const actual = await realpath(prepared.worktreePath);
      if (actual !== prepared.worktreePath) throw new Error('worktree path identity changed');
      const actualRepository = await this.resolveRepository(actual);
      if (
        actualRepository.mainRepo !== prepared.mainRepo ||
        actualRepository.gitCommonDir !== prepared.gitCommonDir
      ) throw new Error('worktree repository identity changed');
    } catch (error) {
      if (
        mutationAttempted &&
        (!(error instanceof ServerCorePinnedMutationError) || !error.cleanupProven)
      ) {
        throw new ServerCoreWorktreeCleanupUnprovedError();
      }
      throw new ServerCoreWorktreeError(
        'Git worktree 创建失败',
        error instanceof ServerCoreWorktreeError
          ? error.hint
          : '仓库、引用和现有目录均已保留；请检查 Git 状态后重试。',
      );
    }
  }

  private async canonicalParentIdentity(
    parent: string,
    expected?: { readonly dev: number; readonly ino: number },
  ): Promise<{ readonly dev: number; readonly ino: number }> {
    try {
      const entry = await lstat(parent);
      const canonical = await realpath(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== parent) {
        throw this.parentError();
      }
      this.assertWorkspacePath(canonical, 'worktree parent');
      if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino)) {
        throw this.parentError();
      }
      return { dev: entry.dev, ino: entry.ino };
    } catch (error) {
      if (error instanceof ServerCoreWorktreeError) throw error;
      throw this.parentError();
    }
  }

  private resolveRelative(value: string): string {
    return value === '.'
      ? this.workspaceRoot
      : path.resolve(this.workspaceRoot, ...value.split('/'));
  }

  private async assertDefaultRootIgnored(mainRepo: string): Promise<void> {
    let ignored = false;
    try {
      const lines = (await readFile(path.join(mainRepo, '.gitignore'), 'utf8')).split(/\r?\n/u);
      ignored = lines.includes('.agent-deck/');
    } catch {
      // Actionable public error below; Core never edits the caller's repository implicitly.
    }
    if (!ignored) {
      throw new ServerCoreWorktreeError(
        '默认 worktree 根目录尚未被 Git 忽略',
        '请先在主仓库 .gitignore 中添加精确的 .agent-deck/ 条目，然后重试。',
      );
    }
  }

  private async createCanonicalParent(parent: string): Promise<string> {
    const requested = path.resolve(parent);
    const missing: string[] = [];
    let cursor = requested;
    let parentIdentity: { readonly dev: number; readonly ino: number } | null = null;
    while (true) {
      try {
        const entry = await lstat(cursor);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw this.parentError();
        const canonical = await realpath(cursor);
        if (canonical !== cursor) throw this.parentError();
        this.assertWorkspacePath(canonical, 'worktree parent');
        parentIdentity = { dev: entry.dev, ino: entry.ino };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof ServerCoreWorktreeError) throw error;
          throw this.parentError();
        }
        const ancestor = path.dirname(cursor);
        if (ancestor === cursor) throw this.parentError();
        missing.push(cursor);
        cursor = ancestor;
      }
    }
    for (const directory of missing.reverse()) {
      try {
        if (!parentIdentity || path.dirname(directory) !== cursor) throw this.parentError();
        await this.createDirectory({
          parent: cursor,
          parentIdentity,
          directoryName: path.basename(directory),
          timeoutMs: PARENT_MUTATION_TIMEOUT_MS,
        });
        parentIdentity = await this.canonicalParentIdentity(directory);
        cursor = directory;
      } catch (error) {
        if (error instanceof ServerCoreWorktreeError) throw error;
        throw this.parentError();
      }
    }
    if (!parentIdentity || cursor !== requested) throw this.parentError();
    await this.canonicalParentIdentity(requested, parentIdentity);
    return requested;
  }

  private parentError(): ServerCoreWorktreeError {
    return new ServerCoreWorktreeError(
      'worktree 父目录不能经过符号链接或被并发替换',
      '请在 Workspace 内选择一个真实目录。',
    );
  }

  private async canonicalExisting(candidate: string, field: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(path.resolve(candidate));
    } catch {
      throw new ServerCoreWorktreeError(
        `${field} 不可用`,
        '请从 Workspace 内一个真实存在的 Git 仓库目录调用该工具。',
      );
    }
    this.assertWorkspacePath(canonical, field);
    return canonical;
  }

  private assertWorkspacePath(candidate: string, field: string): void {
    if (!sameOrInside(candidate, this.workspaceRoot) ||
        this.privateRoots.some((root) => sameOrInside(candidate, root))) {
      throw new ServerCoreWorktreeError(
        `${field} 超出 Workspace 边界`,
        'Remote worktree 只能位于当前 Workspace 内，且不能进入 Worker 私有目录。',
      );
    }
  }

  private async resolveRepository(cwd: string): Promise<{
    readonly mainRepo: string;
    readonly gitCommonDir: string;
    readonly gitCommonIdentity: { readonly dev: number; readonly ino: number };
  }> {
    let common: string;
    try {
      common = await this.runGit(
        ['rev-parse', '--git-common-dir'],
        cwd,
        { timeoutMs: GIT_CHECK_TIMEOUT_MS },
      );
    } catch {
      throw new ServerCoreWorktreeError(
        '当前目录不是可用的 Git 仓库',
        '请在 Workspace 内的 Git 仓库会话中调用 enter_worktree。',
      );
    }
    const commonPath = path.isAbsolute(common) ? common : path.resolve(cwd, common);
    const canonicalCommon = await this.canonicalExisting(commonPath, 'Git metadata');
    const commonEntry = await lstat(canonicalCommon);
    if (!commonEntry.isDirectory() || commonEntry.isSymbolicLink()) {
      throw new ServerCoreWorktreeError(
        'Git metadata identity is invalid',
        '请检查主仓库 Git metadata 后重试。',
      );
    }
    return {
      mainRepo: await this.canonicalExisting(path.dirname(canonicalCommon), 'main repository'),
      gitCommonDir: canonicalCommon,
      gitCommonIdentity: { dev: commonEntry.dev, ino: commonEntry.ino },
    };
  }

  private async resolveCommit(value: string, mainRepo: string): Promise<string> {
    try {
      const commit = (await this.runGit(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`],
        mainRepo,
        { timeoutMs: GIT_CHECK_TIMEOUT_MS },
      )).trim();
      if (FULL_GIT_OBJECT_ID.test(commit)) return commit;
    } catch {
      // Public error below intentionally excludes host paths and stderr.
    }
    throw new ServerCoreWorktreeError(
      'startPoint 没有解析为一个 Git commit',
      '请确认该 revision 存在于当前 Workspace 仓库中。',
    );
  }
}
