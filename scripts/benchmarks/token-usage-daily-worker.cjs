#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const [rootArg, repoArg, dbArg, rowsArg, repetitionsArg] = process.argv.slice(2);
const root = fs.realpathSync(path.resolve(rootArg));
const repo = fs.realpathSync(path.resolve(repoArg));
const dbPath = path.resolve(dbArg);
const rowCount = Number(rowsArg);
const repetitions = Number(repetitionsArg);
const tempRoot = fs.realpathSync('/tmp');
const rootPrefix = `${tempRoot}${path.sep}agent-deck-token-daily-`;

if (!root.startsWith(rootPrefix) || !fs.statSync(root).isDirectory()) {
  throw new Error('Refusing unvalidated benchmark root');
}
if (fs.statSync(root).uid !== process.getuid()) {
  throw new Error('Benchmark root is not owned by the current user');
}
if (!dbPath.startsWith(`${root}${path.sep}`)) {
  throw new Error('Refusing database path outside benchmark root');
}
if (
  !Number.isSafeInteger(rowCount) ||
  rowCount <= 0 ||
  !Number.isSafeInteger(repetitions) ||
  repetitions < 3
) {
  throw new Error('Invalid benchmark row or repetition count');
}
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(`${dbPath}${suffix}`)) {
    throw new Error('Refusing to overwrite existing benchmark fixture');
  }
}

const projectRequire = createRequire(path.join(repo, 'package.json'));
const Database = projectRequire('better-sqlite3');
const ts = projectRequire('typescript');
const metric = Object.freeze({
  total: 1,
  input: 2,
  output: 4,
  reasoning: 8,
  cacheRead: 16,
  cacheCreation: 32,
});
const queryModule = loadTypeScript(
  'src/main/store/token-usage-daily-query.ts',
  (specifier) => {
    if (specifier === '@shared/types') {
      return { TOKEN_USAGE_METRIC: metric };
    }
    throw new Error(`Unexpected daily-query dependency: ${specifier}`);
  },
);
const rollupModule = loadTypeScript(
  'src/main/store/token-usage-daily-rollup.ts',
  (specifier) => {
    if (specifier === './token-usage-daily-query') return queryModule;
    throw new Error(`Unexpected daily-rollup dependency: ${specifier}`);
  },
);
const rawSql = queryModule.buildTokenUsageDailyQuery().sql;
const migrationPaths = [
  'src/main/store/migrations/v028_token_usage.sql',
  'src/main/store/migrations/v035_token_usage_reasoning.sql',
  'src/main/store/migrations/v036_token_usage_model_buckets.sql',
  'src/main/store/migrations/v051_token_usage_presence.sql',
  'src/main/store/migrations/v052_token_usage_metric_scope_repair.sql',
  'src/main/store/migrations/v055_token_usage_daily_rollup.sql',
];
const migrationSql = migrationPaths.map((relativePath) =>
  fs.readFileSync(path.join(repo, relativePath), 'utf8'));
const sourceHashes = Object.fromEntries([
  'src/main/store/token-usage-daily-query.ts',
  'src/main/store/token-usage-daily-rollup.ts',
  ...migrationPaths,
].map((relativePath) => [
  relativePath,
  sha256(fs.readFileSync(path.join(repo, relativePath))),
]));

const setup = buildFixture();
const raw = sampleRaw();
const rollup = sampleRollup(raw.resultFingerprint);
const result = {
  rowCount,
  repetitions,
  environment: environmentInfo(),
  sourceHashes,
  setup,
  raw,
  rollup,
};
process.stdout.write(JSON.stringify(result));

function loadTypeScript(relativePath, fakeRequire) {
  const sourcePath = path.join(repo, relativePath);
  const transpiled = ts.transpileModule(
    fs.readFileSync(sourcePath, 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    },
  ).outputText;
  const record = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function(require, module, exports) { ${transpiled}\n})`,
    { filename: `${sourcePath}.transpiled.cjs` },
  );
  wrapper(fakeRequire, record, record.exports);
  return record.exports;
}

function openDatabase(fileMustExist = true) {
  const db = new Database(dbPath, { fileMustExist });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  return db;
}

function buildFixture() {
  const memoryBefore = process.memoryUsage();
  const db = openDatabase(false);
  const schemaStarted = nowMs();
  for (const sql of migrationSql) db.exec(sql);
  const schemaMs = nowMs() - schemaStarted;
  const insert = db.prepare(
    `INSERT INTO token_usage (
       session_id, agent_id, message_id, model_raw, model_bucket,
       total_tokens, input_tokens, output_tokens, reasoning_tokens,
       cache_read_tokens, cache_creation_tokens, metric_scope, ts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const baseDays = Array.from({ length: 365 }, (_, offset) =>
    new Date(2026, 6, 28 - offset, 12, 0, 0, 0).getTime());
  const sessionCount = Math.max(1, Math.ceil(rowCount / 200));
  const insertAll = db.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) {
      insert.run(...fixtureRow(index, sessionCount, baseDays));
      if (index > 0 && index % 500_000 === 0) {
        process.stderr.write(
          `[token-daily-bench] inserted ${index.toLocaleString()}/${rowCount.toLocaleString()}\n`,
        );
      }
    }
  });
  const insertStarted = nowMs();
  insertAll();
  const insertMs = nowMs() - insertStarted;
  const checkpointStarted = nowMs();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const checkpointMs = nowMs() - checkpointStarted;
  const distributionStarted = nowMs();
  const distribution = {
    rows: db.prepare('SELECT COUNT(*) FROM token_usage').pluck().get(),
    sessions: db.prepare(
      'SELECT COUNT(DISTINCT session_id) FROM token_usage',
    ).pluck().get(),
    days: db.prepare(
      `SELECT COUNT(DISTINCT date(ts/1000, 'unixepoch', 'localtime'))
         FROM token_usage`,
    ).pluck().get(),
    models: db.prepare(
      'SELECT COUNT(DISTINCT model_bucket) FROM token_usage',
    ).pluck().get(),
    agents: db.prepare(
      `SELECT agent_id AS agentId, COUNT(*) AS rows
         FROM token_usage GROUP BY agent_id ORDER BY agent_id`,
    ).all(),
    messages: db.prepare(
      `SELECT SUM(message_id IS NULL) AS nullRows,
              SUM(message_id IS NOT NULL) AS nonNullRows
         FROM token_usage`,
    ).get(),
    dirtyDays: db.prepare(
      'SELECT COUNT(*) FROM token_usage_daily_dirty_days',
    ).pluck().get(),
    sourceRevision: db.prepare(
      'SELECT source_revision FROM token_usage_daily_state',
    ).pluck().get(),
    schemaFingerprint: sha256(JSON.stringify(db.prepare(
      `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ).all())),
  };
  const distributionMs = nowMs() - distributionStarted;
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const pragmas = {
    journalMode: db.pragma('journal_mode', { simple: true }),
    synchronous: db.pragma('synchronous', { simple: true }),
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
    trustedSchema: db.pragma('trusted_schema', { simple: true }),
    pageSize,
    pageCount,
  };
  db.close();
  return {
    schemaMs,
    insertMs,
    checkpointMs,
    distributionMs,
    distribution,
    pragmas,
    databaseBytesBeforeProjection: fileSize(dbPath),
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    fixture: {
      deterministic: true,
      localDayCardinality: 365,
      sessionRows: 200,
      adapterRatio: {
        codexCli: 0.5,
        claudeCode: 0.35,
        grokBuild: 0.15,
      },
      modelCardinality: 12,
      nullableAndScopedRows: true,
    },
  };
}

function fixtureRow(index, sessionCount, baseDays) {
  const agentRoll = index % 20;
  const day = baseDays[(index * 137) % baseDays.length];
  const ts = day + (index % 43_200) * 1000;
  const input = 100 + (index % 500);
  const output = 20 + (index % 200);
  if (agentRoll < 10) {
    const models = ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini', 'o4-mini', 'codex-mini'];
    const model = models[index % models.length];
    const hasCacheWrite = index % 7 !== 0;
    return [
      `s-${index % sessionCount}`, 'codex-cli', null, model, model,
      input + output, input, output, index % 50, index % 80,
      hasCacheWrite ? index % 13 : null,
      1 | 2 | 4 | 8 | 16 | (hasCacheWrite ? 32 : 0), ts,
    ];
  }
  if (agentRoll < 17) {
    const models = ['opus-4.8', 'sonnet-4.5', 'haiku-4.5',
      'claude-unattributed-reasoning'];
    const model = models[index % models.length];
    if (model === 'claude-unattributed-reasoning') {
      return [
        `s-${index % sessionCount}`, 'claude-code', `u-${index.toString(36)}`,
        model, model, null, null, null, index % 41, null, null, 8, ts,
      ];
    }
    return [
      `s-${index % sessionCount}`, 'claude-code', `u-${index.toString(36)}`,
      model, model, null, input, output, index % 41, index % 90,
      index % 17, 63, ts,
    ];
  }
  const models = ['grok-4.5', 'grok-4.1-fast', 'grok-code-fast'];
  const model = models[index % models.length];
  const partial = index % 11 === 0;
  return [
    `s-${index % sessionCount}`, 'grok-build', `u-${index.toString(36)}`,
    model, model, partial ? null : input + output, input, output,
    partial ? null : index % 37, partial ? null : index % 70,
    partial ? index % 19 : null, 63, ts,
  ];
}

function sampleRaw() {
  const planDb = openDatabase();
  const explainQueryPlan = planDb.prepare(
    `EXPLAIN QUERY PLAN ${rawSql}`,
  ).all();
  planDb.close();
  const fresh = sampleFreshConnections((db) =>
    queryModule.queryTokenUsageDaily(db));
  const db = openDatabase();
  queryModule.queryTokenUsageDaily(db);
  const warm = sampleRepeated(() => queryModule.queryTokenUsageDaily(db));
  db.close();
  assertStable(fresh, warm);
  return {
    querySha256: sha256(rawSql),
    queryBytes: Buffer.byteLength(rawSql),
    explainQueryPlan,
    resultRows: fresh.resultRows,
    resultFingerprint: fresh.resultFingerprint,
    freshConnection: summarizeSamples(fresh.samples),
    warm: summarizeSamples(warm.samples),
  };
}

function sampleRollup(expectedFingerprint) {
  const beforeBytes = fileSize(dbPath);
  const buildDb = openDatabase();
  const projection = rollupModule.createTokenUsageDailyRollup(buildDb);
  const memoryBefore = process.memoryUsage();
  const started = nowMs();
  const builtRows = projection.read();
  const buildMs = nowMs() - started;
  const memoryAfter = process.memoryUsage();
  const builtFingerprint = fingerprint(builtRows);
  const state = buildDb.prepare(
    `SELECT source_revision AS sourceRevision,
            projection_revision AS projectionRevision,
            full_rebuild_required AS fullRebuildRequired,
            timezone_fingerprint AS timezoneFingerprint,
            (SELECT COUNT(*) FROM token_usage_daily_dirty_days) AS dirtyDays
       FROM token_usage_daily_state`,
  ).get();
  const explainQueryPlan = buildDb.prepare(
    `EXPLAIN QUERY PLAN
     SELECT * FROM token_usage_daily_rollup ORDER BY day DESC, sort_order`,
  ).all();
  buildDb.pragma('wal_checkpoint(TRUNCATE)');
  buildDb.close();
  if (builtFingerprint !== expectedFingerprint) {
    throw new Error('Projection build fingerprint differs from raw query');
  }

  const fresh = sampleFreshConnections((db) =>
    rollupModule.createTokenUsageDailyRollup(db).read());
  const warmDb = openDatabase();
  const warmProjection = rollupModule.createTokenUsageDailyRollup(warmDb);
  warmProjection.read();
  const warm = sampleRepeated(() => warmProjection.read());
  warmDb.close();
  assertStable(fresh, warm);
  if (fresh.resultFingerprint !== expectedFingerprint) {
    throw new Error('Persistent projection fingerprint differs from raw query');
  }
  return {
    buildMs,
    resultRows: builtRows.length,
    resultFingerprint: builtFingerprint,
    databaseBytesBefore: beforeBytes,
    databaseBytesAfter: fileSize(dbPath),
    addedDatabaseBytes: fileSize(dbPath) - beforeBytes,
    state,
    explainQueryPlan,
    memoryBefore,
    memoryAfter,
    freshConnection: summarizeSamples(fresh.samples),
    warm: summarizeSamples(warm.samples),
  };
}

function sampleFreshConnections(run) {
  const samples = [];
  let resultRows = null;
  let resultFingerprint = null;
  for (let index = 0; index < repetitions; index += 1) {
    const db = openDatabase();
    const sample = timeQuery(() => run(db));
    db.close();
    ({ resultRows, resultFingerprint } = acceptSample(
      sample, resultRows, resultFingerprint,
    ));
    samples.push(sample);
  }
  return { samples, resultRows, resultFingerprint };
}

function sampleRepeated(run) {
  const samples = [];
  let resultRows = null;
  let resultFingerprint = null;
  for (let index = 0; index < repetitions; index += 1) {
    const sample = timeQuery(run);
    ({ resultRows, resultFingerprint } = acceptSample(
      sample, resultRows, resultFingerprint,
    ));
    samples.push(sample);
  }
  return { samples, resultRows, resultFingerprint };
}

function timeQuery(run) {
  const memoryBefore = process.memoryUsage();
  const started = nowMs();
  const rows = run();
  const elapsedMs = nowMs() - started;
  return {
    elapsedMs,
    resultRows: rows.length,
    resultFingerprint: fingerprint(rows),
    rssBefore: memoryBefore.rss,
    rssAfter: process.memoryUsage().rss,
  };
}

function acceptSample(sample, resultRows, resultFingerprint) {
  if (resultRows !== null && sample.resultRows !== resultRows) {
    throw new Error('Benchmark result row count drifted');
  }
  if (resultFingerprint !== null && sample.resultFingerprint !== resultFingerprint) {
    throw new Error('Benchmark result fingerprint drifted');
  }
  return {
    resultRows: sample.resultRows,
    resultFingerprint: sample.resultFingerprint,
  };
}

function assertStable(left, right) {
  if (
    left.resultRows !== right.resultRows ||
    left.resultFingerprint !== right.resultFingerprint
  ) {
    throw new Error('Fresh-connection and warm results differ');
  }
}

function summarizeSamples(samples) {
  const timings = samples.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  return {
    repetitions: timings.length,
    samples,
    medianMs: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    minMs: timings[0],
    maxMs: timings[timings.length - 1],
  };
}

function percentile(sorted, value) {
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
}

function fingerprint(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function environmentInfo() {
  const db = new Database(':memory:');
  const sqliteVersion = db.prepare('SELECT sqlite_version()').pluck().get();
  const sqliteCompileOptions = db.pragma('compile_options')
    .map(({ compile_options: option }) => option);
  db.close();
  return {
    runtime: {
      execPath: process.execPath,
      versions: process.versions,
      electronPackage: projectRequire('electron/package.json').version,
      betterSqlite3Package: projectRequire('better-sqlite3/package.json').version,
    },
    sqliteVersion,
    sqliteCompileOptions,
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: os.version(),
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    resourceUsage: process.resourceUsage(),
  };
}
