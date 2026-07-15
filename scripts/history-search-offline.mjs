#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationSql = readFileSync(
  resolve(repoRoot, 'src/main/store/migrations/v043_history_search_case_insensitive.sql'),
  'utf8',
);
const GIB = 1024n * 1024n * 1024n;
const businessTables = [
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
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { mode: 'migrate', dbPath: '', backupPath: '', smokePassed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--finalize') result.mode = 'finalize';
    else if (arg === '--smoke-passed') result.smokePassed = true;
    else if (arg === '--db') result.dbPath = argv[++index] ?? '';
    else if (arg === '--backup') result.backupPath = argv[++index] ?? '';
    else fail(`unknown argument: ${arg}`);
  }
  if (!result.dbPath) fail('--db is required; pass the path observed from the running app');
  return result;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function assertAppStopped(dbPath) {
  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  }).split('\n');
  const active = processRows.filter((row) => {
    const match = row.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid) return false;
    const command = match[2];
    return command.includes('Agent Deck.app/Contents/MacOS/Agent Deck') ||
      command.includes('Agent Deck.app/Contents/Frameworks/Agent Deck Helper') ||
      command.includes('electron-vite dev');
  });
  if (active.length > 0) {
    fail(`Agent Deck is still running:\n${active.join('\n')}`);
  }

  const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
  if (paths.length > 0) {
    try {
      const output = execFileSync('/usr/sbin/lsof', paths, { encoding: 'utf8' }).trim();
      if (output) fail(`database files are still open:\n${output}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('database files are still open:')) {
        throw error;
      }
      // lsof exits 1 when no descriptor matches.
    }
  }

  const probe = new Database(dbPath, { fileMustExist: true });
  try {
    probe.pragma('busy_timeout = 0');
    probe.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    probe.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    probe.close();
  }
}

function removeClosedSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function readBusinessCounts(db) {
  return Object.fromEntries(businessTables.filter((table) => tableExists(db, table)).map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()),
  ]));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
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
    assertEqual(matchCount(db, table, variant, rowid), 1, `${label} variant ${variant}`);
  }
}

function findAsciiSample(db, sql) {
  for (const row of db.prepare(sql).all()) {
    const match = String(row.text).match(/[A-Za-z]{3,24}/);
    if (match) return { rowid: Number(row.rowid), value: match[0] };
  }
  return null;
}

function verifyTriggersAndShortSearch(db) {
  const marker = `v43-smoke-${Date.now()}`;
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
    ).run(`${marker}-main`, JSON.stringify({ text: 'TriggerFooBar' })).lastInsertRowid);
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

    assertCaseVariants(db, 'event_search_fts_v1', 'TriggerFooBar', eventId, 'event insert');
    assertCaseVariants(db, 'summaries_fts', 'SummaryFooBar', summaryId, 'summary insert');
    db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(
      JSON.stringify({ text: 'UpdatedFooBar' }),
      eventId,
    );
    db.prepare('UPDATE summaries SET content = ? WHERE id = ?').run('UpdatedSummaryBar', summaryId);
    assertEqual(matchCount(db, 'event_search_fts_v1', 'TriggerFooBar', eventId), 0, 'event update old');
    assertCaseVariants(db, 'event_search_fts_v1', 'UpdatedFooBar', eventId, 'event update');
    assertEqual(matchCount(db, 'summaries_fts', 'SummaryFooBar', summaryId), 0, 'summary update old');
    assertCaseVariants(db, 'summaries_fts', 'UpdatedSummaryBar', summaryId, 'summary update');

    const shortHits = db.prepare(
      `SELECT id FROM sessions
        WHERE id LIKE ? AND (title LIKE '%aB%' OR cwd LIKE '%aB%')
        ORDER BY id`,
    ).pluck().all(`${marker}-%`);
    const expectedShortHits = [`${marker}-cwd`, `${marker}-title`].sort();
    if (JSON.stringify(shortHits) !== JSON.stringify(expectedShortHits)) {
      fail(`two-character title/cwd-only search mismatch: ${JSON.stringify(shortHits)}`);
    }

    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId);
    assertEqual(matchCount(db, 'event_search_fts_v1', 'UpdatedFooBar', eventId), 0, 'event delete');
    assertEqual(matchCount(db, 'summaries_fts', 'UpdatedSummaryBar', summaryId), 0, 'summary delete');
  } finally {
    db.exec('ROLLBACK TO v43_trigger_smoke; RELEASE v43_trigger_smoke');
  }
}

function validateV43(db, expectedCounts) {
  assertEqual(Number(db.pragma('user_version', { simple: true })), 43, 'user_version');
  for (const table of ['event_search_fts_v1', 'summaries_fts']) {
    const sql = String(db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(table));
    if (!sql.includes('trigram case_sensitive 0')) fail(`${table} is not case-insensitive`);
  }
  if (tableExists(db, 'events_fts')) fail('legacy events_fts still exists');
  assertEqual(
    String(db.prepare(
      `SELECT phase FROM storage_maintenance_state WHERE task = 'event-search-v1'`,
    ).pluck().get()),
    'complete',
    'event-search-v1 phase',
  );
  for (const [table, count] of Object.entries(expectedCounts)) {
    assertEqual(Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()), count, `${table} rows`);
  }
  assertEqual(Number(db.prepare(
    `SELECT COUNT(*) FROM (
       SELECT event_id FROM event_search_source_v1
       EXCEPT SELECT rowid FROM event_search_fts_v1
     )`,
  ).pluck().get()), 0, 'event FTS missing rowids');
  assertEqual(Number(db.prepare(
    `SELECT COUNT(*) FROM (
       SELECT rowid FROM event_search_fts_v1
       EXCEPT SELECT event_id FROM event_search_source_v1
     )`,
  ).pluck().get()), 0, 'event FTS orphan rowids');
  assertEqual(Number(db.prepare(
    `SELECT COUNT(*) FROM (SELECT id FROM summaries EXCEPT SELECT rowid FROM summaries_fts)`,
  ).pluck().get()), 0, 'summary FTS missing rowids');
  assertEqual(Number(db.prepare(
    `SELECT COUNT(*) FROM (SELECT rowid FROM summaries_fts EXCEPT SELECT id FROM summaries)`,
  ).pluck().get()), 0, 'summary FTS orphan rowids');

  const eventSample = findAsciiSample(db,
    `SELECT event_id AS rowid, search_text AS text FROM event_search_source_v1
      WHERE search_text GLOB '*[A-Za-z]*' LIMIT 2000`,
  );
  if (!eventSample) fail('no ASCII event sample available for case smoke test');
  assertCaseVariants(db, 'event_search_fts_v1', eventSample.value, eventSample.rowid, 'event backfill');
  const summarySample = findAsciiSample(db,
    `SELECT id AS rowid, content AS text FROM summaries
      WHERE content GLOB '*[A-Za-z]*' LIMIT 2000`,
  );
  if (!summarySample) fail('no ASCII summary sample available for case smoke test');
  assertCaseVariants(db, 'summaries_fts', summarySample.value, summarySample.rowid, 'summary backfill');

  verifyTriggersAndShortSearch(db);
  db.prepare(
    `INSERT INTO event_search_fts_v1(event_search_fts_v1) VALUES('integrity-check')`,
  ).run();
  db.prepare(
    `INSERT INTO summaries_fts(summaries_fts, rank) VALUES('integrity-check', 1)`,
  ).run();
  assertEqual(String(db.pragma('quick_check', { simple: true })), 'ok', 'quick_check');
  const foreignKeys = db.pragma('foreign_key_check');
  if (foreignKeys.length > 0) fail(`foreign_key_check failed: ${JSON.stringify(foreignKeys)}`);
}

function fsyncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function migrate(dbPath) {
  assertAppStopped(dbPath);
  const sourceSize = BigInt(lstatSync(dbPath).size);
  const stats = statfsSync(dirname(dbPath), { bigint: true });
  const available = stats.bavail * stats.bsize;
  const required = sourceSize * 2n > 5n * GIB ? sourceSize * 2n : 5n * GIB;
  if (available < required) {
    fail(`insufficient disk space: need ${required / GIB}GiB, have ${available / GIB}GiB`);
  }

  const stamp = timestamp();
  const candidate = `${dbPath}.v43-${stamp}.tmp`;
  const backup = `${dbPath}.${stamp}.bak`;
  if (existsSync(candidate) || existsSync(backup)) fail('candidate or backup path already exists');

  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  let expectedCounts;
  try {
    assertEqual(Number(source.pragma('user_version', { simple: true })), 42, 'source user_version');
    expectedCounts = readBusinessCounts(source);
    console.log(`[history-search-migration] copying ${dbPath}`);
    await source.backup(candidate, {
      progress({ totalPages, remainingPages }) {
        const completed = totalPages - remainingPages;
        if (completed === 0 || remainingPages === 0 || completed % 100000 === 0) {
          console.log(`[history-search-migration] copy ${completed}/${totalPages} pages`);
        }
        return 4096;
      },
    });
  } finally {
    source.close();
  }

  const copy = new Database(candidate, { fileMustExist: true });
  try {
    copy.pragma('foreign_keys = ON');
    copy.pragma('trusted_schema = ON');
    copy.pragma('journal_mode = WAL');
    copy.pragma('synchronous = FULL');
    console.log('[history-search-migration] rebuilding case-insensitive FTS indexes');
    copy.transaction(() => {
      copy.exec(migrationSql);
      copy.pragma('user_version = 43');
    })();
    console.log('[history-search-migration] validating migrated copy');
    validateV43(copy, expectedCounts);
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
  } catch (error) {
    console.error(`[history-search-migration] validation failed; original preserved; candidate kept at ${candidate}`);
    throw error;
  } finally {
    copy.close();
  }
  removeClosedSidecars(candidate);
  assertAppStopped(dbPath);

  console.log(`[history-search-migration] switching atomically; backup=${backup}`);
  renameSync(dbPath, backup);
  try {
    renameSync(candidate, dbPath);
    fsyncDirectory(dirname(dbPath));
  } catch (error) {
    renameSync(backup, dbPath);
    throw error;
  }
  removeClosedSidecars(dbPath);
  console.log(`[history-search-migration] complete; keep backup until UI smoke succeeds: ${backup}`);
  console.log(JSON.stringify({ dbPath, backupPath: backup, userVersion: 43 }));
}

function finalize(dbPath, backupPath, smokePassed) {
  if (!smokePassed) fail('--smoke-passed is required before backup deletion');
  if (!backupPath) fail('--backup is required with --finalize');
  const backup = realpathSync(backupPath);
  if (dirname(backup) !== dirname(dbPath)) fail('backup must be beside the database');
  assertAppStopped(dbPath);
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    const counts = readBusinessCounts(db);
    validateV43(db, counts);
  } finally {
    db.close();
  }
  rmSync(backup);
  removeClosedSidecars(backup);
  fsyncDirectory(dirname(dbPath));
  console.log(`[history-search-migration] finalized; deleted verified backup ${backup}`);
}

const args = parseArgs(process.argv.slice(2));
const dbPath = realpathSync(args.dbPath);
if (args.mode === 'finalize') finalize(dbPath, args.backupPath, args.smokePassed);
else await migrate(dbPath);
