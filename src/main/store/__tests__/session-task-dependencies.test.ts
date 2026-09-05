import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskRepo, type TaskRepo } from '../task-repo';
import { bindingAvailable, insertSession, makeMemoryDb } from './agent-deck-repos/_setup';
import { createEnterWithDb } from '../worktree-transition-repo';
import { renameWithDb } from '../session-repo/rename';

let currentDb: Database.Database;
vi.mock('../db', () => ({ getDb: () => currentDb }));

import { _delete as deleteSession } from '../session-repo/core-crud';
import { batchDeleteHistory } from '../session-repo/lifecycle';

const candidate = (id: string) => ({ id, cliSessionId: null, lastEventAt: 1 });

describe.skipIf(!bindingAvailable)('session task dependency integrity', () => {
  let repo: TaskRepo;

  beforeEach(() => {
    currentDb = makeMemoryDb();
    repo = createTaskRepo(currentDb);
    insertSession(currentDb, 'retired');
    insertSession(currentDb, 'live');
    currentDb.prepare(
      "UPDATE sessions SET lifecycle = 'closed', last_event_at = 1 WHERE id = 'retired'",
    ).run();
  });
  afterEach(() => currentDb.close());

  function graph() {
    const removed = repo.create({ subject: 'removed', ownerSessionId: 'retired' });
    const retained = repo.create({ subject: 'retained', ownerSessionId: 'live' });
    const survivor = repo.create({
      subject: 'survivor', ownerSessionId: 'live',
      blocks: [removed.id, retained.id], blockedBy: [retained.id, removed.id],
    });
    return { removed, retained, survivor };
  }

  function remove(mode: 'direct' | 'retention') {
    if (mode === 'direct') deleteSession('retired');
    else expect(batchDeleteHistory([candidate('retired')], 100)).toEqual([candidate('retired')]);
  }

  it.each(['direct', 'retention'] as const)('%s deletion removes both dependency directions', (mode) => {
    const { removed, retained, survivor } = graph();
    remove(mode);
    expect(repo.get(removed.id)).toBeNull();
    expect(repo.get(retained.id)).toEqual(retained);
    expect(repo.get(survivor.id)).toEqual({
      ...survivor, blocks: [retained.id], blockedBy: [retained.id],
    });
    expect(currentDb.prepare("SELECT lifecycle FROM sessions WHERE id = 'live'").pluck().get())
      .toBe('active');
  });

  it.each(['direct', 'retention'] as const)('%s cleanup failure rolls back session and task deletion', (mode) => {
    const { removed, survivor } = graph();
    currentDb.exec(`
      CREATE TRIGGER reject_dependency_cleanup BEFORE UPDATE OF blocks, blocked_by ON tasks
      WHEN OLD.subject = 'survivor'
      BEGIN SELECT RAISE(ABORT, 'cleanup blocked'); END;
    `);
    expect(() => remove(mode)).toThrow('cleanup blocked');
    expect(currentDb.prepare("SELECT id FROM sessions WHERE id = 'retired'").pluck().get())
      .toBe('retired');
    expect(repo.get(removed.id)).toEqual(removed);
    expect(repo.get(survivor.id)).toEqual(survivor);
  });

  function holdWorktree(id: string) {
    createEnterWithDb(currentDb, {
      sessionId: id, originalCwd: '/repo', targetCwd: '/repo/worktree', mainRepo: '/repo',
      worktreePath: '/repo/worktree', baseCommit: 'a'.repeat(40), toolUseId: `enter-${id}`,
      continuationKey: `continue-${id}`, requestedAt: 10,
    });
  }

  it('retention cleans only deleted owners after rechecking pin, age, activity and lease', () => {
    const protectedIds = ['pinned', 'recent', 'active', 'leased'];
    for (const id of protectedIds) insertSession(currentDb, id);
    currentDb.exec(`
      UPDATE sessions SET lifecycle = 'closed', last_event_at = 1 WHERE id IN ('pinned', 'leased');
      UPDATE sessions SET pinned_at = 2 WHERE id = 'pinned';
      UPDATE sessions SET lifecycle = 'closed', last_event_at = 101 WHERE id = 'recent';
      UPDATE sessions SET last_event_at = 1 WHERE id = 'active';
    `);
    holdWorktree('leased');
    const kept = protectedIds.map((id) => repo.create({ subject: id, ownerSessionId: id }).id);
    const removed = repo.create({ subject: 'old', ownerSessionId: 'retired' });
    const survivor = repo.create({
      subject: 'survivor', ownerSessionId: 'live',
      blocks: [removed.id, ...kept], blockedBy: [...kept, removed.id],
    });
    const candidates = ['retired', ...protectedIds, 'missing'].map(candidate);
    expect(batchDeleteHistory(candidates, 100)).toEqual([candidate('retired')]);
    expect(repo.get(survivor.id)).toMatchObject({ blocks: kept, blockedBy: kept });
    for (const id of kept) expect(repo.get(id)).not.toBeNull();
  });

  it('direct deletion leaves the graph intact when a worktree lease prevents deletion', () => {
    const { removed, survivor } = graph();
    holdWorktree('retired');
    expect(() => deleteSession('retired')).toThrow('Cannot delete session');
    expect(repo.get(removed.id)).toEqual(removed);
    expect(repo.get(survivor.id)).toEqual(survivor);
  });

  it('explicit task deletion shares dependency repair without changing content order', () => {
    const { removed, survivor } = graph();
    currentDb.prepare('UPDATE tasks SET blocks = ?, blocked_by = ? WHERE id = ?')
      .run('not-json', '[1, "bad-shape"]', survivor.id);
    expect(repo.delete(removed.id)).toEqual([removed.id]);
    expect(repo.get(survivor.id)).toEqual({ ...survivor, blocks: [], blockedBy: [] });
    expect(currentDb.prepare('SELECT blocks, blocked_by FROM tasks WHERE id = ?').get(survivor.id))
      .toEqual({ blocks: '[]', blocked_by: '[]' });
  });

  it('canonical session rename transfers tasks before deleting the old owner', () => {
    const { removed, survivor } = graph();
    renameWithDb(currentDb, 'retired', 'canonical');
    expect(repo.get(removed.id)).toEqual({ ...removed, ownerSessionId: 'canonical' });
    expect(repo.get(survivor.id)).toEqual(survivor);
  });
});
