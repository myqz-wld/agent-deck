import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { serverCoreWorktreeReferenceFence } from './worktree-reference-fence';

describe('serverCoreWorktreeReferenceFence', () => {
  it('serializes new nested cwd references with destructive cleanup', () => {
    const root = `/tmp/worktree-fence-${randomUUID()}`;
    const reference = serverCoreWorktreeReferenceFence.acquireReference(`${root}/nested`);
    expect(() => serverCoreWorktreeReferenceFence.acquireCleanup(root))
      .toThrow('registered');
    reference.release();

    const cleanup = serverCoreWorktreeReferenceFence.acquireCleanup(root);
    expect(() => serverCoreWorktreeReferenceFence.acquireReference(`${root}/nested`))
      .toThrow('retired');
    cleanup.release();

    const after = serverCoreWorktreeReferenceFence.acquireReference(`${root}/nested`);
    after.release();
  });

  it('serializes enter mutations with ancestor and descendant cleanup', () => {
    const root = `/tmp/worktree-mutation-${randomUUID()}`;
    const mutation = serverCoreWorktreeReferenceFence.acquireMutation(`${root}/nested`);
    expect(() => serverCoreWorktreeReferenceFence.acquireCleanup(root)).toThrow('created');
    expect(() => serverCoreWorktreeReferenceFence.acquireCleanup(`${root}/nested/child`))
      .toThrow('created');
    mutation.release();

    const ancestorCleanup = serverCoreWorktreeReferenceFence.acquireCleanup(root);
    expect(() => serverCoreWorktreeReferenceFence.acquireMutation(`${root}/nested`))
      .toThrow('cleanup');
    ancestorCleanup.release();

    const descendantCleanup = serverCoreWorktreeReferenceFence.acquireCleanup(`${root}/nested`);
    expect(() => serverCoreWorktreeReferenceFence.acquireMutation(root)).toThrow('cleanup');
    descendantCleanup.release();
  });
});
