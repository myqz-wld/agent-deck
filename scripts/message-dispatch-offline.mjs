#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAppStopped,
  removeClosedSidecars,
} from './history-search-offline/validation.mjs';

export const SOURCE_VERSION = 55;
export const TARGET_VERSION = 56;
export const INDEX_NAME = 'idx_messages_pending_sent_at';
const MIN_FREE_BYTES = 512n * 1024n * 1024n;
const EXCLUSION_TARGET = '00000000-0000-4000-8000-ffffffffffff';
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const production = require('./benchmarks/agent-deck-message-dispatch-production.cjs');
const migrationSql = readFileSync(
  join(
    repoRoot,
    'src/main/store/migrations/v056_agent_deck_messages_pending_order.sql',
  ),
  'utf8',
);
const expectedIndexSql =
  `CREATE INDEX ${INDEX_NAME} ON agent_deck_messages(status, sent_at) ` +
  `WHERE status = 'pending'`;

export class MessageDispatchMigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MessageDispatchMigrationError';
    this.code = code;
  }
}

function fail(code) {
  throw new MessageDispatchMigrationError(code);
}

function normalizeSql(value) {
  return String(value).replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
}

function fixedMigrationContract() {
  if (normalizeSql(migrationSql) !== normalizeSql(expectedIndexSql)) {
    fail('migration-contract');
  }
}

export function failureDiagnostic(error) {
  return {
    event: 'message-dispatch-offline',
    outcome: 'failed',
    code: error instanceof MessageDispatchMigrationError
      ? error.code
      : 'internal-failure',
  };
}

export function resolveDatabasePath(input, {
  currentUid = () => process.getuid?.() ?? -1,
} = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    fail('invalid-arguments');
  }
  const lexical = resolve(input);
  let lexicalStats;
  try {
    lexicalStats = lstatSync(lexical);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('database-missing');
    fail('path-inspection');
  }
  if (lexicalStats.isSymbolicLink()) fail('database-symlink');
  if (!lexicalStats.isFile()) fail('database-not-regular');
  if (lexicalStats.uid !== currentUid()) fail('database-owner');

  let canonicalParent;
  try {
    canonicalParent = realpathSync(dirname(lexical));
  } catch {
    fail('path-inspection');
  }
  const canonical = join(canonicalParent, basename(lexical));
  let canonicalStats;
  try {
    canonicalStats = lstatSync(canonical);
  } catch {
    fail('path-inspection');
  }
  if (
    !canonicalStats.isFile() ||
    canonicalStats.isSymbolicLink() ||
    canonicalStats.dev !== lexicalStats.dev ||
    canonicalStats.ino !== lexicalStats.ino
  ) {
    fail('path-identity');
  }
  return canonical;
}

export function requiredFreeBytes(databaseBytes) {
  const bytes = BigInt(databaseBytes);
  const proportional = (bytes + 1n) / 2n;
  return proportional > MIN_FREE_BYTES ? proportional : MIN_FREE_BYTES;
}

function defaultAvailableBytes(dbPath) {
  const stats = statfsSync(dirname(dbPath), { bigint: true });
  return stats.bavail * stats.bsize;
}

function indexSql(db) {
  return db.prepare(
    `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`,
  ).pluck().get(INDEX_NAME) ?? null;
}

function versionOf(db) {
  return Number(db.pragma('user_version', { simple: true }));
}

function assertExactIndex(db, inconsistentCode) {
  if (normalizeSql(indexSql(db) ?? '') !== normalizeSql(expectedIndexSql)) {
    fail(inconsistentCode);
  }
}

function assertHealth(db) {
  if (String(db.pragma('quick_check', { simple: true })) !== 'ok') {
    fail('quick-check');
  }
  if (String(db.pragma('integrity_check', { simple: true })) !== 'ok') {
    fail('integrity-check');
  }
  if (db.pragma('foreign_key_check').length > 0) {
    fail('foreign-key-check');
  }
}

function selectionEvidence(db, capture, now) {
  const input = {
    now,
    limit: 16,
    excludeTargets: [EXCLUSION_TARGET],
  };
  const rows = production.selectProductionRows(db, capture, input);
  return {
    input,
    rows,
    fingerprints: {
      eligible: production.resultFingerprint(rows.eligibleRows),
      excluding: production.resultFingerprint(rows.excludingRows),
    },
  };
}

function assertPlan(db, capture, input) {
  const plans = production.explainProduction(db, capture, input);
  for (const plan of [plans.eligible, plans.excluding]) {
    const details = production.planDetails(plan).join(' ');
    if (
      !details.includes(`USING INDEX ${INDEX_NAME}`) ||
      details.includes('TEMP B-TREE')
    ) {
      fail('plan-validation');
    }
  }
  return plans;
}

function assertSameSelection(before, after) {
  if (
    before.fingerprints.eligible !== after.fingerprints.eligible ||
    before.fingerprints.excluding !== after.fingerprints.excluding ||
    JSON.stringify(before.rows) !== JSON.stringify(after.rows)
  ) {
    fail('fingerprint-validation');
  }
}

function injectFault(faultAt, phase) {
  if (faultAt === phase) fail(`injected-${phase}`);
}

function cleanupVerifiedDatabase(dbPath) {
  let cleanup;
  let safeToRemoveSidecars = false;
  try {
    cleanup = new Database(dbPath, { fileMustExist: true });
    cleanup.pragma('busy_timeout = 0');
    cleanup.exec('BEGIN IMMEDIATE; ROLLBACK;');
    cleanup.pragma('wal_checkpoint(TRUNCATE)');
    safeToRemoveSidecars = true;
  } catch {
    return;
  } finally {
    cleanup?.close();
  }
  if (!safeToRemoveSidecars) return;
  rmSync(`${dbPath}-journal`, { force: true });
  removeClosedSidecars(dbPath);
}

function assertFileIdentity(dbPath, identity) {
  let current;
  try {
    current = lstatSync(dbPath);
  } catch {
    fail('path-identity');
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.uid !== identity.uid
  ) {
    fail('path-identity');
  }
}

export function runMessageDispatchMigration({
  dbPath: dbInput,
  assertStopped = (Db, paths, probes) =>
    assertAppStopped(Db, paths, probes),
  availableBytes = defaultAvailableBytes,
  faultAt = null,
  onPhase = () => {},
  report = null,
} = {}) {
  fixedMigrationContract();
  const dbPath = resolveDatabasePath(dbInput);
  const identity = lstatSync(dbPath);
  let exclusiveVerified = false;
  let db;
  try {
    assertStopped(
      Database,
      [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`],
      [dbPath],
    );
    exclusiveVerified = true;
    assertFileIdentity(dbPath, identity);
    if (availableBytes(dbPath) < requiredFreeBytes(identity.size)) {
      fail('insufficient-disk');
    }

    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    const capture = production.captureProductionDispatch(
      repoRoot,
      [EXCLUSION_TARGET],
    );
    const version = versionOf(db);

    if (version === TARGET_VERSION) {
      assertExactIndex(db, 'inconsistent-v56');
      const current = selectionEvidence(db, capture, Date.now());
      assertPlan(db, capture, current.input);
      assertHealth(db);
      const result = {
        outcome: 'already-complete',
        fromVersion: TARGET_VERSION,
        toVersion: TARGET_VERSION,
        indexName: INDEX_NAME,
        fingerprints: current.fingerprints,
      };
      report?.(result);
      return result;
    }
    if (version !== SOURCE_VERSION) fail('unsupported-version');
    if (indexSql(db) !== null) fail('inconsistent-v55');

    const before = selectionEvidence(db, capture, Date.now());
    const migrate = db.transaction(() => {
      injectFault(faultAt, 'create-index');
      onPhase('create-index');
      db.exec(migrationSql);
      assertExactIndex(db, 'index-validation');
      injectFault(faultAt, 'plan');
      const after = selectionEvidence(db, capture, before.input.now);
      assertPlan(db, capture, after.input);
      assertSameSelection(before, after);
      injectFault(faultAt, 'quick-check');
      assertHealth(db);
      db.pragma(`user_version = ${TARGET_VERSION}`);
      injectFault(faultAt, 'before-commit');
    });
    migrate.immediate();

    const result = {
      outcome: 'migrated',
      fromVersion: SOURCE_VERSION,
      toVersion: TARGET_VERSION,
      indexName: INDEX_NAME,
      fingerprints: before.fingerprints,
    };
    report?.(result);
    return result;
  } finally {
    db?.close();
    if (exclusiveVerified) cleanupVerifiedDatabase(dbPath);
  }
}

export function parseArgs(args) {
  let dbPath = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--db') {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail('invalid-arguments');
      dbPath = value;
      continue;
    }
    fail('invalid-arguments');
  }
  if (!dbPath) fail('invalid-arguments');
  return { dbPath };
}

export function main(args = process.argv.slice(2)) {
  try {
    const result = runMessageDispatchMigration(parseArgs(args));
    process.stdout.write(JSON.stringify({
      event: 'message-dispatch-offline',
      outcome: result.outcome,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      indexName: result.indexName,
    }) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureDiagnostic(error))}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}
