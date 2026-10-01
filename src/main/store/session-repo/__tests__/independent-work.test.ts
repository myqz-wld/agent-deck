import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingAvailable, makeMemoryDb } from './_setup';

let db: Database.Database;
vi.mock('../../db', () => ({ getDb: () => db }));
import { promoteIndependentWork } from '../independent-work';

function insert(id: string, parent: string | null, depth: number): void {
  db.prepare(`INSERT INTO sessions (id, agent_id, cwd, title, source, lifecycle, activity,
    started_at, last_event_at, spawned_by, spawn_depth)
    VALUES (?, 'codex-cli', '/workspaces/demo', ?, 'sdk', 'active', 'finished', 1, 2, ?, ?)`)
    .run(id, id, parent, depth);
}
function rows() {
  return db.prepare('SELECT id, spawned_by AS parent, spawn_depth AS depth FROM sessions ORDER BY id').all();
}

describe.skipIf(!bindingAvailable)('independent owner work hierarchy', () => {
  beforeEach(() => { db = makeMemoryDb(); });
  afterEach(() => db.close());

  it('promotes only the verified work and rebases its real delegated subtree atomically', () => {
    insert('assistant', null, 0); insert('work', 'assistant', 1);
    insert('child', 'work', 2); insert('grandchild', 'child', 3);
    insert('other-child', 'assistant', 1);
    expect(new Set(promoteIndependentWork('work', 'assistant'))).toEqual(new Set(['work', 'child', 'grandchild']));
    expect(rows()).toEqual([
      { id: 'assistant', parent: null, depth: 0 }, { id: 'child', parent: 'work', depth: 1 },
      { id: 'grandchild', parent: 'child', depth: 2 }, { id: 'other-child', parent: 'assistant', depth: 1 },
      { id: 'work', parent: null, depth: 0 },
    ]);
    expect(promoteIndependentWork('work', 'assistant')).toEqual([]);
  });

  it('rejects a changed parent, missing row or inconsistent subtree without partial edits', () => {
    insert('assistant', null, 0); insert('work', 'assistant', 1); insert('child', 'work', 7);
    const before = rows();
    expect(() => promoteIndependentWork('work', 'another-assistant')).toThrow('edge changed');
    expect(() => promoteIndependentWork('missing', 'assistant')).toThrow('missing');
    expect(() => promoteIndependentWork('work', 'assistant')).toThrow('inconsistent');
    expect(rows()).toEqual(before);
  });

  it('does not traverse cycles indefinitely or rewrite an inconsistent cycle', () => {
    insert('assistant', null, 0); insert('work', 'assistant', 1);
    db.prepare('UPDATE sessions SET spawned_by = ? WHERE id = ?').run('work', 'assistant');
    const before = rows();
    expect(() => promoteIndependentWork('work', 'assistant')).toThrow('inconsistent');
    expect(rows()).toEqual(before);
  });
});
