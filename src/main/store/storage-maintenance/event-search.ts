import { performance } from 'node:perf_hooks';
import type { Database } from 'better-sqlite3';
import {
  adaptBatchSize,
  readMaintenanceState,
  updateMaintenanceState,
  type StorageMaintenanceState,
} from './state';

const TASK = 'event-search-v1' as const;

export interface MaintenanceSliceResult {
  task: typeof TASK;
  phase: string;
  processed: number;
  durationMs: number;
  doneForRun: boolean;
}

export interface LegacyEventSearchRetirementResult {
  retired: boolean;
  durationMs: number;
  freedPages: number;
}

interface SearchRow {
  event_id: number;
  search_text: string;
  change_revision: number | null;
}

interface EventVersionRow {
  event_id: number;
  change_revision: number | null;
}

/** Deterministic seam for exercising a second WAL writer between selection and write-lock entry. */
export interface EventSearchSliceTestHooks {
  afterBackfillPreselect?: (eventIds: readonly number[]) => void;
}

export function runEventSearchSlice(
  db: Database,
  testHooks: EventSearchSliceTestHooks = {},
): MaintenanceSliceResult | null {
  const state = readMaintenanceState(db, TASK);
  if (!state) return null;
  if (state.phase === 'backfill') return backfill(db, state, testHooks);
  if (state.phase === 'verify') return verify(db, state);
  if (state.phase === 'restart-verify') return verifyEventRowids(db, state);
  if (state.phase === 'restart-verify-orphans') return verifyIndexRowids(db, state);
  if (state.phase === 'restart-verify-search') return verifySearchSamples(db, state);
  return {
    task: TASK,
    phase: state.phase,
    processed: 0,
    durationMs: 0,
    doneForRun: true,
  };
}

/** Called only when the scheduler observed awaiting-restart before this app run started. */
export function beginEventSearchRestartVerification(db: Database): void {
  const state = readMaintenanceState(db, TASK);
  if (state?.phase !== 'awaiting-restart') return;
  updateMaintenanceState(db, TASK, {
    phase: 'restart-verify',
    cursor: 0,
    upperBound: Number(db.prepare('SELECT COALESCE(MAX(id), 0) FROM events').pluck().get()),
    batchSize: 500,
    lastError: null,
  });
}

function backfill(
  db: Database,
  state: StorageMaintenanceState,
  testHooks: EventSearchSliceTestHooks,
): MaintenanceSliceResult {
  const started = performance.now();
  const rows = db.prepare(
    `SELECT source.event_id, source.search_text, events.change_revision
       FROM event_search_source_v1 source
       JOIN events ON events.id = source.event_id
      WHERE source.event_id > ? AND source.event_id <= ?
      ORDER BY source.event_id ASC LIMIT ?`,
  ).all(state.cursor, state.upperBound, state.batchSize) as SearchRow[];
  if (rows.length === 0) {
    updateMaintenanceState(db, TASK, {
      phase: 'verify',
      cursor: state.upperBound,
      lastError: null,
    });
    return result('verify', 0, performance.now() - started, false);
  }

  const remove = db.prepare('DELETE FROM event_search_fts_v1 WHERE rowid = ?');
  const insert = db.prepare(
    'INSERT INTO event_search_fts_v1(rowid, search_text) VALUES (?, ?)',
  );
  const eventIds = rows.map((row) => row.event_id);
  const placeholders = eventIds.map(() => '?').join(', ');
  const readCurrentVersions = db.prepare(
    `SELECT id AS event_id, change_revision FROM events WHERE id IN (${placeholders})`,
  );

  testHooks.afterBackfillPreselect?.(Object.freeze([...eventIds]));

  const tx = db.transaction(() => {
    // The initial projection deliberately stays outside the write lock. Once BEGIN IMMEDIATE has
    // serialized us with live ingress, revisions identify the uncommon rows that changed in the
    // gap. Re-project only those rows; a missing id was deleted and must not be resurrected.
    const currentVersions = readCurrentVersions.all(...eventIds) as EventVersionRow[];
    const currentById = new Map(currentVersions.map((row) => [row.event_id, row]));
    const changedIds = rows
      .filter((row) => {
        const current = currentById.get(row.event_id);
        return current !== undefined && current.change_revision !== row.change_revision;
      })
      .map((row) => row.event_id);
    const refreshedById = new Map<number, string>();
    if (changedIds.length > 0) {
      const changedPlaceholders = changedIds.map(() => '?').join(', ');
      const refreshed = db.prepare(
        `SELECT event_id, search_text FROM event_search_source_v1
          WHERE event_id IN (${changedPlaceholders})`,
      ).all(...changedIds) as Array<Pick<SearchRow, 'event_id' | 'search_text'>>;
      for (const row of refreshed) refreshedById.set(row.event_id, row.search_text);
    }

    for (const row of rows) {
      const current = currentById.get(row.event_id);
      if (!current) continue;
      const searchText = current.change_revision === row.change_revision
        ? row.search_text
        : refreshedById.get(row.event_id);
      if (searchText === undefined) {
        throw new Error(
          `event search source disappeared while write-locked: eventId=${row.event_id}`,
        );
      }
      // An old event may have been updated after v041 and already dual-written. Contentless-delete
      // makes the replace sequence safe for both present and absent rowids.
      remove.run(row.event_id);
      insert.run(row.event_id, searchText);
    }
    updateMaintenanceState(db, TASK, {
      cursor: rows[rows.length - 1].event_id,
      lastError: null,
    });
  });
  // A deferred read transaction cannot safely upgrade after another WAL writer commits. Acquire the
  // write reservation first, then validate/re-project and mutate in one short critical section.
  tx.immediate();
  const durationMs = performance.now() - started;
  const batchSize = adaptBatchSize(state.batchSize, durationMs, { min: 10, max: 50 });
  if (batchSize !== state.batchSize) updateMaintenanceState(db, TASK, { batchSize });
  return result('backfill', rows.length, durationMs, false);
}

function verify(db: Database, state: StorageMaintenanceState): MaintenanceSliceResult {
  const started = performance.now();
  const sourceCount = Number(db.prepare(
    'SELECT COUNT(id) FROM events INDEXED BY idx_events_kind WHERE id <= ?',
  ).pluck().get(state.upperBound));
  const indexCount = Number(db.prepare(
    'SELECT COUNT(*) FROM event_search_fts_v1 WHERE rowid <= ?',
  ).pluck().get(state.upperBound));
  if (sourceCount !== indexCount) {
    throw new Error(
      `event search backfill count mismatch: events=${sourceCount}, index=${indexCount}`,
    );
  }
  updateMaintenanceState(db, TASK, {
    phase: 'awaiting-restart',
    cursor: state.upperBound,
    lastError: null,
  });
  return result('awaiting-restart', sourceCount, performance.now() - started, true);
}

function verifyEventRowids(
  db: Database,
  state: StorageMaintenanceState,
): MaintenanceSliceResult {
  const started = performance.now();
  const rows = db.prepare(
    `SELECT source_rows.id, index_rows.rowid AS peer_id
       FROM (
         SELECT id FROM events WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?
       ) source_rows
       LEFT JOIN event_search_fts_v1 index_rows ON index_rows.rowid = source_rows.id
      ORDER BY source_rows.id ASC`,
  ).all(state.cursor, state.upperBound, state.batchSize) as Array<{
    id: number;
    peer_id: number | null;
  }>;
  const missing = rows.find((row) => row.peer_id === null);
  if (missing) throw new Error(`event search index missing eventId=${missing.id}`);
  if (rows.length === 0) {
    const indexUpperBound = Number(
      db.prepare('SELECT COALESCE(MAX(rowid), 0) FROM event_search_fts_v1').pluck().get(),
    );
    updateMaintenanceState(db, TASK, {
      phase: 'restart-verify-orphans',
      cursor: 0,
      upperBound: indexUpperBound,
      batchSize: 500,
      lastError: null,
    });
    return result('restart-verify-orphans', 0, performance.now() - started, false);
  }
  updateMaintenanceState(db, TASK, {
    cursor: rows[rows.length - 1].id,
    lastError: null,
  });
  return result('restart-verify', rows.length, performance.now() - started, false);
}

function verifyIndexRowids(
  db: Database,
  state: StorageMaintenanceState,
): MaintenanceSliceResult {
  const started = performance.now();
  const rows = db.prepare(
    `SELECT index_rows.rowid AS id, source_rows.id AS peer_id
       FROM (
         SELECT rowid FROM event_search_fts_v1
          WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC LIMIT ?
       ) index_rows
       LEFT JOIN events source_rows ON source_rows.id = index_rows.rowid
      ORDER BY index_rows.rowid ASC`,
  ).all(state.cursor, state.upperBound, state.batchSize) as Array<{
    id: number;
    peer_id: number | null;
  }>;
  const orphan = rows.find((row) => row.peer_id === null);
  if (orphan) throw new Error(`event search index orphan rowid=${orphan.id}`);
  if (rows.length === 0) {
    updateMaintenanceState(db, TASK, {
      phase: 'restart-verify-search',
      cursor: 0,
      upperBound: Number(db.prepare('SELECT COALESCE(MAX(id), 0) FROM events').pluck().get()),
      batchSize: 12,
      lastError: null,
    });
    return result('restart-verify-search', 0, performance.now() - started, false);
  }
  updateMaintenanceState(db, TASK, {
    cursor: rows[rows.length - 1].id,
    lastError: null,
  });
  return result('restart-verify-orphans', rows.length, performance.now() - started, false);
}

function verifySearchSamples(
  db: Database,
  state: StorageMaintenanceState,
): MaintenanceSliceResult {
  const started = performance.now();
  assertSearchSamples(db, state.upperBound, state.batchSize);
  updateMaintenanceState(db, TASK, {
    phase: 'retire-on-shutdown',
    cursor: 0,
    lastError: null,
  });
  return result('retire-on-shutdown', state.batchSize, performance.now() - started, true);
}

/**
 * Retires the 1GiB legacy raw-payload FTS only after all adapters and ingress servers drained.
 * DROP is intentionally forbidden from startup and maintenance ticks: cold production-size copies
 * measured 5.81-5.99s, so lifecycle invokes this only through the dedicated shutdown worker. The
 * empty compatibility table keeps prepared history SQL valid after retirement.
 */
export function retireLegacyEventSearchIndexOnShutdown(
  db: Database,
): LegacyEventSearchRetirementResult {
  const state = readMaintenanceState(db, TASK);
  if (state?.phase !== 'retire-on-shutdown') {
    return { retired: false, durationMs: 0, freedPages: 0 };
  }
  const started = performance.now();
  const freelistBefore = Number(db.pragma('freelist_count', { simple: true }));
  const tx = db.transaction(() => {
    const eventCount = Number(db.prepare('SELECT COUNT(*) FROM events').pluck().get());
    const indexCount = Number(
      db.prepare('SELECT COUNT(*) FROM event_search_fts_v1').pluck().get(),
    );
    if (eventCount !== indexCount) {
      throw new Error(
        `event search shutdown count mismatch: events=${eventCount}, index=${indexCount}`,
      );
    }
    db.exec(`
      DROP TRIGGER IF EXISTS events_ai;
      DROP TRIGGER IF EXISTS events_ad;
      DROP TRIGGER IF EXISTS events_au;
      DROP TABLE IF EXISTS events_fts;
      CREATE VIRTUAL TABLE events_fts USING fts5(
        payload_json,
        content='',
        contentless_delete=1,
        tokenize='trigram case_sensitive 1'
      );
    `);
    updateMaintenanceState(db, TASK, {
      phase: 'complete',
      lastError: null,
    });
  });
  tx();
  const durationMs = performance.now() - started;
  const freelistAfter = Number(db.pragma('freelist_count', { simple: true }));
  return {
    retired: true,
    durationMs,
    freedPages: Math.max(0, freelistAfter - freelistBefore),
  };
}

function assertSearchSamples(db: Database, upperBound: number, sampleLimit: number): void {
  if (upperBound === 0) return;
  const findSample = db.prepare(
    `SELECT event_id, search_text FROM event_search_source_v1
      WHERE event_id >= ? AND event_id <= ? ORDER BY event_id ASC LIMIT 100`,
  );
  const check = db.prepare(
    `SELECT 1 FROM event_search_fts_v1
      WHERE event_search_fts_v1 MATCH ? AND rowid = ? LIMIT 1`,
  );
  const seen = new Set<number>();
  for (let index = 0; index < sampleLimit; index += 1) {
    const threshold = Math.floor((upperBound * index) / Math.max(1, sampleLimit - 1));
    const candidates = findSample.all(threshold, upperBound) as SearchRow[];
    const sample = candidates.find((candidate) =>
      !seen.has(candidate.event_id) && /[\p{L}\p{N}]{3}/u.test(candidate.search_text),
    );
    if (!sample) continue;
    seen.add(sample.event_id);
    const marker = sample.search_text.match(/[\p{L}\p{N}]{3}/u)![0];
    const phrase = `"${marker.replaceAll('"', '""')}"`;
    if (!check.get(phrase, sample.event_id)) {
      throw new Error(`event search restart smoke mismatch: eventId=${sample.event_id}`);
    }
  }
}

function result(
  phase: string,
  processed: number,
  durationMs: number,
  doneForRun: boolean,
): MaintenanceSliceResult {
  return { task: TASK, phase, processed, durationMs, doneForRun };
}
