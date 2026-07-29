#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const [
  rootArg,
  repoArg,
  dbArg,
  rowsArg,
  repetitionsArg,
  freshRepetitionsArg,
  writeRepetitionsArg,
] = process.argv.slice(2);
const root = fs.realpathSync(path.resolve(rootArg));
const repo = fs.realpathSync(path.resolve(repoArg));
const dbPath = path.resolve(dbArg);
const rowCount = Number(rowsArg);
const repetitions = Number(repetitionsArg);
const freshRepetitions = Number(freshRepetitionsArg);
const writeRepetitions = Number(writeRepetitionsArg);
const tempRoot = fs.realpathSync('/tmp');
const requiredPrefix = `${tempRoot}${path.sep}agent-deck-message-dispatch-`;

validateInputs();

const projectRequire = createRequire(path.join(repo, 'package.json'));
const Database = projectRequire('better-sqlite3');
const production = require('./agent-deck-message-dispatch-production.cjs');
const fixture = require('./agent-deck-message-dispatch-fixture.cjs');
const measure = require('./agent-deck-message-dispatch-measure.cjs');
const benchmarkPaths = [
  'src/main/teams/universal-message-watcher/index.ts',
  'scripts/benchmarks/agent-deck-message-dispatch.mjs',
  'scripts/benchmarks/agent-deck-message-dispatch-worker.cjs',
  'scripts/benchmarks/agent-deck-message-dispatch-production.cjs',
  'scripts/benchmarks/agent-deck-message-dispatch-fixture.cjs',
  'scripts/benchmarks/agent-deck-message-dispatch-measure.cjs',
];

let db;
let result;
try {
  const inventory = production.captureMigrationInventory(repo);
  const v56 = assertMigrationContract(inventory);
  const capture = production.captureProductionDispatch(repo, ['target-000']);
  const built = fixture.buildFixture({
    Database,
    dbPath,
    rowCount,
    migrations: inventory.migrations,
  });
  built.db.close();

  db = openDatabase();
  const environment = environmentInfo(db);
  const input = {
    now: fixture.FIXTURE_NOW,
    limit: 16,
    excludeTargets: ['target-000'],
  };
  const before = measure.measureSelection({
    Database,
    db,
    dbPath,
    production,
    capture,
    input,
    repetitions,
    freshRepetitions,
  });
  const writesBefore = measure.measureWrites({
    db,
    production,
    repoRoot: repo,
    repetitions: writeRepetitions,
    phase: 'before',
  });
  const indexBuild = measure.installV56({
    db,
    dbPath,
    migration: v56,
  });
  db.close();
  db = openDatabase();
  const after = measure.measureSelection({
    Database,
    db,
    dbPath,
    production,
    capture,
    input,
    repetitions,
    freshRepetitions,
  });
  const writesAfter = measure.measureWrites({
    db,
    production,
    repoRoot: repo,
    repetitions: writeRepetitions,
    phase: 'after',
  });

  assertEvidence(db, before, after);
  const health = databaseHealth(db);
  const sourceHashes = {
    ...inventory.sourceHashes,
    ...capture.sourceHashes,
    ...writesBefore.sourceHashes,
    ...hashFiles(benchmarkPaths),
  };
  result = {
    rowCount,
    samples: { repetitions, freshRepetitions, writeRepetitions },
    environment,
    fixture: built.setup,
    contracts: {
      productionSql: {
        eligible: capture.eligibleSql,
        excluding: capture.excludingSql,
        countPendingForTarget: capture.countSql,
      },
      sqlHashes: capture.sqlHashes,
      sourceHashes,
      migrationsThroughV55Sha256: inventory.throughV55SqlSha256,
      v56: {
        path: v56.path,
        sha256: v56.sha256,
        sql: v56.sql,
      },
    },
    before,
    indexBuild,
    after,
    writes: {
      before: writesBefore,
      after: writesAfter,
      amplification: writeAmplification(writesBefore, writesAfter),
    },
    health,
    finalFiles: fixture.fileSizes(dbPath),
  };
} finally {
  db?.close();
  cleanupFixture();
}

result.cleanup = {
  databaseRemoved: !fs.existsSync(dbPath),
  walRemoved: !fs.existsSync(`${dbPath}-wal`),
  shmRemoved: !fs.existsSync(`${dbPath}-shm`),
  reportRootRetained: true,
};
process.stdout.write(JSON.stringify(result));

function validateInputs() {
  const rootStats = fs.statSync(root);
  if (!root.startsWith(requiredPrefix) || !rootStats.isDirectory()) {
    throw new Error('Refusing unvalidated benchmark root');
  }
  if (rootStats.uid !== process.getuid()) {
    throw new Error('Benchmark root is not caller-owned');
  }
  if (!dbPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Refusing database path outside benchmark root');
  }
  if (!fs.statSync(repo).isDirectory()) {
    throw new Error('Benchmark repository root is not a directory');
  }
  const integers = [rowCount, repetitions, freshRepetitions, writeRepetitions];
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount <= 0 ||
    integers.slice(1).some((value) =>
      !Number.isSafeInteger(value) || value < 3)
  ) {
    throw new Error('Invalid benchmark row or repetition count');
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) {
      throw new Error('Refusing existing benchmark fixture');
    }
  }
  if (process.versions.modules !== '130') {
    throw new Error('Benchmark requires the project Electron ABI 130');
  }
}

function openDatabase() {
  const opened = new Database(dbPath, {
    fileMustExist: true,
  });
  opened.pragma('journal_mode = WAL');
  opened.pragma('foreign_keys = ON');
  opened.pragma('trusted_schema = ON');
  return opened;
}

function assertMigrationContract(inventory) {
  if (inventory.latestVersion !== 56) {
    throw new Error('Benchmark requires V056 as the latest migration');
  }
  const migration = inventory.migrations.at(-1);
  const normalized = migration.sql.replace(/\s+/g, ' ').trim();
  const expected =
    "CREATE INDEX idx_messages_pending_sent_at ON " +
    "agent_deck_messages(status, sent_at) WHERE status = 'pending';";
  if (
    migration.version !== 56 ||
    migration.path !==
      'src/main/store/migrations/v056_agent_deck_messages_pending_order.sql' ||
    normalized !== expected
  ) {
    throw new Error('V056 migration contract mismatch');
  }
  return migration;
}

function assertEvidence(database, before, after) {
  if (JSON.stringify(before.result) !== JSON.stringify(after.result)) {
    throw new Error('Before/after dispatch result fingerprint mismatch');
  }
  const beforePlans = [
    ...before.plans.eligible,
    ...before.plans.excluding,
  ].join(' ');
  if (!beforePlans.includes('TEMP B-TREE')) {
    throw new Error('V055 production plans unexpectedly lack temp ordering');
  }
  for (const plan of [after.plans.eligible, after.plans.excluding]) {
    const text = plan.join(' ');
    if (
      !text.includes('USING INDEX idx_messages_pending_sent_at') ||
      text.includes('TEMP B-TREE')
    ) {
      throw new Error('V056 production plan did not use the pending-order index');
    }
  }
  if (Number(database.pragma('user_version', { simple: true })) !== 56) {
    throw new Error('Benchmark migration did not finish at V056');
  }
}

function databaseHealth(database) {
  return {
    quickCheck: database.pragma('quick_check', { simple: true }),
    integrityCheck: database.pragma('integrity_check', { simple: true }),
    foreignKeyViolations: database.pragma('foreign_key_check').length,
    userVersion: Number(database.pragma('user_version', { simple: true })),
    indexes: database.prepare(
      `SELECT name, sql FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'agent_deck_messages'
        ORDER BY name`,
    ).all(),
  };
}

function environmentInfo(database) {
  const betterSqliteVersion = projectRequire(
    'better-sqlite3/package.json',
  ).version;
  return {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    cpu: {
      model: os.cpus()[0]?.model ?? 'unknown',
      logicalCores: os.cpus().length,
    },
    totalMemoryBytes: os.totalmem(),
    processVersions: process.versions,
    betterSqlite3Version: betterSqliteVersion,
    sqliteVersion: database.prepare(
      'SELECT sqlite_version() AS version',
    ).get().version,
    sqliteCompileOptions: database.pragma('compile_options')
      .map((row) => row.compile_options),
    resourceUsage: process.resourceUsage(),
    memory: process.memoryUsage(),
  };
}

function hashFiles(relativePaths) {
  return Object.fromEntries(relativePaths.map((relativePath) => [
    relativePath,
    crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(repo, relativePath)))
      .digest('hex'),
  ]));
}

function ratio(after, before) {
  return {
    medianDeltaMs: after.medianMs - before.medianMs,
    p95DeltaMs: after.p95Ms - before.p95Ms,
    medianRatio: before.medianMs === 0 ? null :
      after.medianMs / before.medianMs,
    p95Ratio: before.p95Ms === 0 ? null : after.p95Ms / before.p95Ms,
  };
}

function writeAmplification(before, after) {
  return {
    enqueueInsertAndGet: ratio(
      after.enqueueInsertAndGet,
      before.enqueueInsertAndGet,
    ),
    claim: ratio(after.claim, before.claim),
    acknowledgeUpdateAndGet: ratio(
      after.acknowledgeUpdateAndGet,
      before.acknowledgeUpdateAndGet,
    ),
    retrySelectUpdateAndGet: ratio(
      after.retrySelectUpdateAndGet,
      before.retrySelectUpdateAndGet,
    ),
  };
}

function cleanupFixture() {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = path.resolve(`${dbPath}${suffix}`);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error('Refusing cleanup outside benchmark root');
    }
    fs.rmSync(target, { force: true });
  }
}
