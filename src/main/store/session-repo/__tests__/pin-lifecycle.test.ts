import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { bindingAvailable, makeMemoryDb } from './_setup';
import { renameWithDb } from '../rename';

let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('[pin-lifecycle.test] database is not initialized');
    return currentDb;
  },
}));

import { sessionRepo, SessionPinStateError } from '../index';
import * as coreCrud from '../core-crud';

function insertSession(
  db: Database.Database,
  id: string,
  lifecycle: 'active' | 'dormant' | 'closed' = 'active',
  lastEventAt = 100,
  archivedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
        ended_at, archived_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', ?, 'idle', 1, ?, ?, ?)`,
  ).run(
    id,
    `title-${id}`,
    lifecycle,
    lastEventAt,
    lifecycle === 'closed' ? lastEventAt : null,
    archivedAt,
  );
}

describe.skipIf(!bindingAvailable)('session pinning and lifecycle guards', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    currentDb = db;
  });

  afterEach(() => {
    currentDb = null;
    db.close();
  });

  it('pins idempotently, survives stale upsert, and unpins through the dedicated setter', () => {
    insertSession(db, 'active');
    const stale = sessionRepo.get('active')!;

    expect(sessionRepo.setPinned('active', 500).pinnedAt).toBe(500);
    expect(sessionRepo.setPinned('active', 900).pinnedAt).toBe(500);

    coreCrud.upsert({ ...stale, title: 'updated by stale full record' });
    expect(sessionRepo.get('active')).toMatchObject({
      title: 'updated by stale full record',
      pinnedAt: 500,
    });

    expect(sessionRepo.setPinned('active', null).pinnedAt).toBeNull();
  });

  it('reactivates dormant rows while pinning and rejects archived or closed rows', () => {
    insertSession(db, 'dormant', 'dormant');
    insertSession(db, 'closed', 'closed');
    insertSession(db, 'archived', 'active', 100, 50);

    expect(sessionRepo.setPinned('dormant', 1000)).toMatchObject({
      lifecycle: 'active',
      endedAt: null,
      pinnedAt: 1000,
    });
    for (const id of ['closed', 'archived']) {
      expect(() => sessionRepo.setPinned(id, 1000)).toThrowError(SessionPinStateError);
    }
    expect(() => sessionRepo.setPinned('missing', 1000)).toThrowError(
      expect.objectContaining({ code: 'missing' }),
    );
  });

  it('includes an old pinned row before the UI limit without changing recency list ordering', () => {
    for (let index = 0; index < 120; index += 1) {
      insertSession(db, `recent-${index.toString().padStart(3, '0')}`, 'active', 1000 + index);
    }
    insertSession(db, 'old-pinned', 'active', 1);
    sessionRepo.setPinned('old-pinned', 5000);

    expect(sessionRepo.listActiveAndDormant(100).some((row) => row.id === 'old-pinned')).toBe(
      false,
    );
    const uiRows = sessionRepo.listLiveForUi(100);
    expect(uiRows[0]).toMatchObject({ id: 'old-pinned', pinnedAt: 5000 });
    expect(uiRows).toHaveLength(100);
  });

  it('returns every explicitly pinned live row even when pin count exceeds UI capacity', () => {
    for (let index = 0; index < 12; index += 1) {
      const id = `pinned-${index.toString().padStart(2, '0')}`;
      insertSession(db, id, 'active', index);
      sessionRepo.setPinned(id, 1000 + index);
    }

    const rows = sessionRepo.listLiveForUi(10);
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.pinnedAt != null)).toBe(true);
  });

  it('keeps transitive spawn owners and fallback team leads for a pinned row beyond capacity', () => {
    for (let index = 0; index < 120; index += 1) {
      insertSession(db, `recent-${index.toString().padStart(3, '0')}`, 'active', 1000 + index);
    }
    insertSession(db, 'grand-owner', 'active', 1);
    insertSession(db, 'old-owner', 'active', 2);
    insertSession(db, 'old-team-lead', 'active', 3);
    insertSession(db, 'pinned-child', 'active', 4);
    db.prepare(`UPDATE sessions SET spawned_by = ? WHERE id = ?`).run(
      'grand-owner',
      'old-owner',
    );
    db.prepare(`UPDATE sessions SET spawned_by = ? WHERE id = ?`).run(
      'old-owner',
      'pinned-child',
    );
    db.prepare(
      `INSERT INTO agent_deck_teams (id, name, created_at, archived_at, metadata)
       VALUES ('old-team', 'old-team', 1, NULL, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_deck_team_members
       (team_id, session_id, role, display_name, joined_at, left_at)
       VALUES ('old-team', 'pinned-child', 'teammate', NULL, 1, NULL),
              ('old-team', 'old-team-lead', 'lead', NULL, 1, NULL)`,
    ).run();
    sessionRepo.setPinned('pinned-child', 5000);

    const rows = sessionRepo.listLiveForUi(100);
    const ids = new Set(rows.map((row) => row.id));
    expect(rows).toHaveLength(103);
    expect(rows[0]).toMatchObject({ id: 'pinned-child', pinnedAt: 5000 });
    for (const id of ['pinned-child', 'old-owner', 'grand-owner', 'old-team-lead']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('preserves the source pin across both rename paths, including NULL clearing target state', () => {
    insertSession(db, 'old-missing-target');
    sessionRepo.setPinned('old-missing-target', 700);
    renameWithDb(db, 'old-missing-target', 'new-missing-target');
    expect(sessionRepo.get('new-missing-target')?.pinnedAt).toBe(700);

    insertSession(db, 'old-existing-target');
    insertSession(db, 'new-existing-target');
    sessionRepo.setPinned('new-existing-target', 900);
    renameWithDb(db, 'old-existing-target', 'new-existing-target');
    expect(sessionRepo.get('new-existing-target')?.pinnedAt).toBeNull();
  });

  it('rechecks pin, source lifecycle, and inactivity at the lifecycle write boundary', () => {
    insertSession(db, 'pin-race', 'active', 10);
    insertSession(db, 'reactivate-race', 'dormant', 10);
    insertSession(db, 'activity-race', 'active', 10);

    expect(sessionRepo.findActiveExpiring(20).map((row) => row.id)).toContain('pin-race');
    sessionRepo.setPinned('pin-race', 1000);
    expect(
      sessionRepo.batchAdvanceLifecycle(['pin-race'], 'active', 'dormant', 100, 20),
    ).toEqual([]);

    sessionRepo.setLifecycle('reactivate-race', 'active', 100);
    expect(
      sessionRepo.batchAdvanceLifecycle(
        ['reactivate-race'],
        'dormant',
        'closed',
        100,
        20,
      ),
    ).toEqual([]);

    sessionRepo.setActivity('activity-race', 'working', 30);
    expect(
      sessionRepo.batchAdvanceLifecycle(['activity-race'], 'active', 'dormant', 100, 20),
    ).toEqual([]);
    expect(sessionRepo.get('pin-race')?.lifecycle).toBe('active');
    expect(sessionRepo.get('reactivate-race')?.lifecycle).toBe('active');
    expect(sessionRepo.get('activity-race')?.lifecycle).toBe('active');
  });

  it('rechecks history predicates before delete and clears pin on terminal event state', () => {
    insertSession(db, 'history-race', 'active', 10, 5);
    expect(sessionRepo.findHistoryOlderThan(20)).toContain('history-race');
    sessionRepo.setArchived('history-race', null);
    sessionRepo.setPinned('history-race', 800);
    expect(sessionRepo.batchDeleteHistory(['history-race'], 20)).toEqual([]);
    expect(sessionRepo.get('history-race')).not.toBeNull();

    sessionRepo.setEventState('history-race', 'idle', 'dormant', 30, {
      clearPinned: true,
    });
    expect(sessionRepo.get('history-race')).toMatchObject({
      lifecycle: 'dormant',
      lastEventAt: 30,
      pinnedAt: null,
    });
  });
});
