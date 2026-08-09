import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ServerCoreWorktreeReferenceLease {
  release(): void;
}

function sameOrInside(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (
    child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

function lease(release: () => void): ServerCoreWorktreeReferenceLease {
  let active = true;
  return Object.freeze({
    release: () => {
      if (!active) return;
      active = false;
      release();
    },
  });
}

/** Fences new session cwd registration against destructive worktree cleanup. */
class ServerCoreWorktreeReferenceFence {
  private readonly readers = new Map<symbol, string>();
  private readonly mutations = new Map<symbol, string>();
  private readonly retiring = new Set<string>();

  acquireReference(cwd: string): ServerCoreWorktreeReferenceLease {
    const canonical = resolve(cwd);
    if ([...this.retiring].some((root) => sameOrInside(canonical, root))) {
      throw new Error('Working directory is being retired');
    }
    const token = Symbol('worktree-reference');
    this.readers.set(token, canonical);
    return lease(() => this.readers.delete(token));
  }

  acquireMutation(worktreePath: string): ServerCoreWorktreeReferenceLease {
    const canonical = resolve(worktreePath);
    if ([...this.retiring].some((root) =>
      sameOrInside(canonical, root) || sameOrInside(root, canonical))) {
      throw new Error('Worktree path overlaps active cleanup');
    }
    const token = Symbol('worktree-mutation');
    this.mutations.set(token, canonical);
    return lease(() => this.mutations.delete(token));
  }

  acquireCleanup(worktreePath: string): ServerCoreWorktreeReferenceLease {
    const canonical = resolve(worktreePath);
    if ([...this.retiring].some((root) =>
      sameOrInside(canonical, root) || sameOrInside(root, canonical))) {
      throw new Error('Worktree cleanup is already active');
    }
    if ([...this.readers.values()].some((cwd) => sameOrInside(cwd, canonical))) {
      throw new Error('Worktree is being registered by another session');
    }
    if ([...this.mutations.values()].some((target) =>
      sameOrInside(target, canonical) || sameOrInside(canonical, target))) {
      throw new Error('Worktree is being created by another session');
    }
    this.retiring.add(canonical);
    return lease(() => this.retiring.delete(canonical));
  }
}

export const serverCoreWorktreeReferenceFence = new ServerCoreWorktreeReferenceFence();
