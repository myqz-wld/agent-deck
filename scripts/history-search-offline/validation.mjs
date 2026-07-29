import { execFileSync } from 'node:child_process';
import {
  existsSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  fileIdentity,
  sameFileIdentity,
  sameSourceIdentity,
} from './journal.mjs';

const GIB = 1024n * 1024n * 1024n;
export const BUSINESS_TABLES = Object.freeze([
  'sessions',
  'events',
  'summaries',
  'file_changes',
  'tasks',
  'issues',
  'issue_appendices',
  'agent_deck_teams',
  'agent_deck_team_members',
  'agent_deck_messages',
  'token_usage',
  'continuation_checkpoints',
  'session_event_revisions',
  'session_handoff_aliases',
]);

function fail(message) {
  throw new Error(message);
}
export function removeClosedSidecars(path) {
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

export function assertAppStopped(
  Database,
  allPaths,
  probePaths = [],
  { processRows: injectedProcessRows = null } = {},
) {
  const processRows = injectedProcessRows ?? execFileSync(
    '/bin/ps',
    ['-axo', 'pid=,command='],
    { encoding: 'utf8' },
  ).split('\n');
  const active = processRows.some((row) => {
    const match = row.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid) return false;
    const command = match[2];
    return (
      command.includes('Agent Deck.app/Contents/MacOS/Agent Deck') ||
      command.includes('Agent Deck.app/Contents/Frameworks/Agent Deck Helper') ||
      command.includes('electron-vite dev')
    );
  });
  if (active) {
    fail('Agent Deck is still running. Fully quit it, then rerun the same command.');
  }

  const existingPaths = allPaths.filter(
    (path) => path && existsSync(path),
  );
  if (existingPaths.length > 0) {
    try {
      const output = execFileSync('/usr/sbin/lsof', existingPaths, {
        encoding: 'utf8',
      }).trim();
      if (output) {
        fail('Database files are open. Fully quit their owner, then rerun.');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Database files are open.')
      ) {
        throw error;
      }
      if (typeof error?.status === 'number' && error.status !== 1) {
        fail('Unable to verify open database descriptors. Resolve the check and rerun.');
      }
    }
  }

  for (const path of probePaths.filter(
    (candidate) => candidate && existsSync(candidate),
  )) {
    let probe;
    try {
      probe = new Database(path, { fileMustExist: true });
      probe.pragma('busy_timeout = 0');
      probe.exec('BEGIN EXCLUSIVE; ROLLBACK;');
      probe.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      fail('Database lock check failed. Fully quit every writer, then rerun.');
    } finally {
      probe?.close();
    }
  }
}

export function assertDiskSpace(
  dbPath,
  sourceSize,
  { statfs: readStats = statfsSync } = {},
) {
  const stats = readStats(dirname(dbPath), { bigint: true });
  const available = stats.bavail * stats.bsize;
  const size = BigInt(sourceSize);
  const required = size * 2n > 5n * GIB ? size * 2n : 5n * GIB;
  if (available < required) {
    fail(
      `Insufficient disk space: need ${required / GIB}GiB, ` +
      `have ${available / GIB}GiB. Free space, then rerun.`,
    );
  }
}

export function assertIdentity(path, expected, label, strict = false) {
  const actual = existsSync(path) ? fileIdentity(path) : null;
  const matches = strict
    ? sameSourceIdentity(actual, expected)
    : sameFileIdentity(actual, expected);
  if (!matches) {
    fail(`${label} no longer matches the journal lineage. Do not rename files manually.`);
  }
}

export function openSourceFile(
  Database, path, expectedCounts = null, expectedIdentity = null,
) {
  if (expectedIdentity) {
    assertIdentity(path, expectedIdentity, 'Source database', true);
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    return validateSourceV42(db, expectedCounts);
  } finally {
    db.close();
  }
}

export function validateCandidateFile(
  Database, path, expectedCounts, exactVersion = null,
) {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    validateV43(db, {
      expectedCounts,
      exactVersion,
      minVersion: 43,
    });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  removeClosedSidecars(path);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function assertRequiredTables(db) {
  for (const table of [
    ...BUSINESS_TABLES,
    'event_search_fts_v1',
    'summaries_fts',
    'storage_maintenance_state',
  ]) {
    if (!tableExists(db, table)) fail(`required table is missing: ${table}`);
  }
}

export function readBusinessCounts(db) {
  return Object.fromEntries(
    BUSINESS_TABLES
      .filter((table) => tableExists(db, table))
      .map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()),
      ]),
  );
}

function assertBusinessCounts(db, expectedCounts) {
  for (const table of BUSINESS_TABLES) {
    if (!Object.hasOwn(expectedCounts, table)) fail(`missing row count: ${table}`);
  }
  for (const [table, count] of Object.entries(expectedCounts)) {
    if (!tableExists(db, table)) fail(`business table disappeared: ${table}`);
    assertEqual(
      Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()),
      count,
      `${table} rows`,
    );
  }
}

function assertDatabaseHealth(db) {
  assertEqual(
    String(db.pragma('quick_check', { simple: true })),
    'ok',
    'quick_check',
  );
  assertEqual(
    String(db.pragma('integrity_check', { simple: true })),
    'ok',
    'integrity_check',
  );
  const foreignKeys = db.pragma('foreign_key_check');
  if (foreignKeys.length > 0) {
    fail(`foreign_key_check failed with ${foreignKeys.length} row(s)`);
  }
}

export function validateSourceV42(db, expectedCounts = null) {
  assertEqual(
    Number(db.pragma('user_version', { simple: true })),
    42,
    'source user_version',
  );
  assertRequiredTables(db);
  if (expectedCounts) assertBusinessCounts(db, expectedCounts);
  assertDatabaseHealth(db);
  return expectedCounts ?? readBusinessCounts(db);
}

function phrase(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function matchCount(db, table, value, rowid) {
  return Number(db.prepare(
    `SELECT COUNT(*) FROM ${table} WHERE ${table} MATCH ? AND rowid = ?`,
  ).pluck().get(phrase(value), rowid));
}

function assertCaseVariants(db, table, value, rowid, label) {
  for (const variant of [value, value.toLowerCase(), value.toUpperCase()]) {
    assertEqual(
      matchCount(db, table, variant, rowid),
      1,
      `${label} case variant`,
    );
  }
}

function findAsciiSample(db, sql) {
  for (const row of db.prepare(sql).all()) {
    const match = String(row.text).match(/[A-Za-z]{3,24}/);
    if (match) return { rowid: Number(row.rowid), value: match[0] };
  }
  return null;
}

function verifyBackfillCaseVariants(db) {
  const eventSample = findAsciiSample(
    db,
    `SELECT event_id AS rowid, search_text AS text FROM event_search_source_v1
      WHERE search_text GLOB '*[A-Za-z]*' LIMIT 2000`,
  );
  if (eventSample) {
    assertCaseVariants(
      db,
      'event_search_fts_v1',
      eventSample.value,
      eventSample.rowid,
      'event backfill',
    );
  }

  const summarySample = findAsciiSample(
    db,
    `SELECT id AS rowid, content AS text FROM summaries
      WHERE content GLOB '*[A-Za-z]*' LIMIT 2000`,
  );
  if (summarySample) {
    assertCaseVariants(
      db,
      'summaries_fts',
      summarySample.value,
      summarySample.rowid,
      'summary backfill',
    );
  }
}

function verifyTriggersAndShortSearch(db) {
  const marker = `v43-smoke-${process.pid}-${Date.now()}`;
  db.exec('SAVEPOINT v43_trigger_smoke');
  try {
    const insertSession = db.prepare(
      `INSERT INTO sessions
        (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
       VALUES (?, 'codex-cli', ?, ?, 'sdk', 'closed', 'idle', 1, 1)`,
    );
    insertSession.run(`${marker}-main`, '/repo', 'generic');
    insertSession.run(`${marker}-title`, '/repo', 'contains Ab marker');
    insertSession.run(`${marker}-cwd`, '/Repo/AB-path', 'generic');
    insertSession.run(`${marker}-event-short`, '/repo', 'generic');
    insertSession.run(`${marker}-summary-short`, '/repo', 'generic');

    const eventId = Number(db.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES (?, 'message', ?, 2, NULL)`,
    ).run(
      `${marker}-main`,
      JSON.stringify({ text: 'TriggerFooBar' }),
    ).lastInsertRowid);
    const summaryId = Number(db.prepare(
      `INSERT INTO summaries(session_id, content, trigger, ts)
       VALUES (?, 'SummaryFooBar', 'manual', 3)`,
    ).run(`${marker}-main`).lastInsertRowid);
    db.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES (?, 'message', ?, 4, NULL)`,
    ).run(`${marker}-event-short`, JSON.stringify({ text: 'Ab' }));
    db.prepare(
      `INSERT INTO summaries(session_id, content, trigger, ts)
       VALUES (?, 'Ab', 'manual', 5)`,
    ).run(`${marker}-summary-short`);

    assertCaseVariants(
      db,
      'event_search_fts_v1',
      'TriggerFooBar',
      eventId,
      'event insert',
    );
    assertCaseVariants(
      db,
      'summaries_fts',
      'SummaryFooBar',
      summaryId,
      'summary insert',
    );
    db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(
      JSON.stringify({ text: 'UpdatedFooBar' }),
      eventId,
    );
    db.prepare('UPDATE summaries SET content = ? WHERE id = ?').run(
      'UpdatedSummaryBar',
      summaryId,
    );
    assertEqual(
      matchCount(db, 'event_search_fts_v1', 'TriggerFooBar', eventId),
      0,
      'event update old',
    );
    assertCaseVariants(
      db,
      'event_search_fts_v1',
      'UpdatedFooBar',
      eventId,
      'event update',
    );
    assertEqual(
      matchCount(db, 'summaries_fts', 'SummaryFooBar', summaryId),
      0,
      'summary update old',
    );
    assertCaseVariants(
      db,
      'summaries_fts',
      'UpdatedSummaryBar',
      summaryId,
      'summary update',
    );

    const shortHits = db.prepare(
      `SELECT id FROM sessions
       WHERE id LIKE ? AND (title LIKE '%aB%' OR cwd LIKE '%aB%')
       ORDER BY id`,
    ).pluck().all(`${marker}-%`);
    const expected = [`${marker}-cwd`, `${marker}-title`].sort();
    if (JSON.stringify(shortHits) !== JSON.stringify(expected)) {
      fail('two-character title/cwd-only search mismatch');
    }

    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId);
    assertEqual(
      matchCount(db, 'event_search_fts_v1', 'UpdatedFooBar', eventId),
      0,
      'event delete',
    );
    assertEqual(
      matchCount(db, 'summaries_fts', 'UpdatedSummaryBar', summaryId),
      0,
      'summary delete',
    );
  } finally {
    db.exec('ROLLBACK TO v43_trigger_smoke; RELEASE v43_trigger_smoke');
  }
}

function assertFtsParity(db) {
  const parityChecks = [
    [
      `SELECT COUNT(*) FROM (
         SELECT event_id FROM event_search_source_v1
         EXCEPT SELECT rowid FROM event_search_fts_v1
       )`,
      'event FTS missing rowids',
    ],
    [
      `SELECT COUNT(*) FROM (
         SELECT rowid FROM event_search_fts_v1
         EXCEPT SELECT event_id FROM event_search_source_v1
       )`,
      'event FTS orphan rowids',
    ],
    [
      `SELECT COUNT(*) FROM (
         SELECT id FROM summaries EXCEPT SELECT rowid FROM summaries_fts
       )`,
      'summary FTS missing rowids',
    ],
    [
      `SELECT COUNT(*) FROM (
         SELECT rowid FROM summaries_fts EXCEPT SELECT id FROM summaries
       )`,
      'summary FTS orphan rowids',
    ],
  ];
  for (const [sql, label] of parityChecks) {
    assertEqual(Number(db.prepare(sql).pluck().get()), 0, label);
  }
}

export function validateV43(
  db,
  {
    expectedCounts = null,
    exactVersion = null,
    minVersion = 43,
  } = {},
) {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (exactVersion !== null) {
    assertEqual(version, exactVersion, 'user_version');
  } else if (version < minVersion) {
    fail(`user_version must be at least ${minVersion}, got ${version}`);
  }
  assertRequiredTables(db);
  for (const table of ['event_search_fts_v1', 'summaries_fts']) {
    const sql = String(
      db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').pluck().get(table),
    );
    if (!sql.includes('trigram case_sensitive 0')) {
      fail(`${table} is not case-insensitive`);
    }
  }
  if (tableExists(db, 'events_fts')) fail('legacy events_fts still exists');
  assertEqual(
    String(db.prepare(
      `SELECT phase FROM storage_maintenance_state
       WHERE task = 'event-search-v1'`,
    ).pluck().get()),
    'complete',
    'event-search-v1 phase',
  );
  if (expectedCounts) assertBusinessCounts(db, expectedCounts);
  assertFtsParity(db);
  verifyBackfillCaseVariants(db);
  verifyTriggersAndShortSearch(db);
  db.prepare(
    `INSERT INTO event_search_fts_v1(event_search_fts_v1)
     VALUES('integrity-check')`,
  ).run();
  db.prepare(
    `INSERT INTO summaries_fts(summaries_fts, rank)
     VALUES('integrity-check', 1)`,
  ).run();
  assertDatabaseHealth(db);
}
