#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createJournal,
  fileIdentity,
  journalEntryExists,
  makeReportingTransition,
  readJournal,
  reportMigration,
  resolveLineagePaths,
  writeJournal,
} from './history-search-offline/journal.mjs';
import {
  classifyLineageSnapshot,
  copySource,
  discardPartialCandidate,
  fsyncDirectory,
  installReadyCandidate,
  migrateCandidate,
  rollbackToSource,
  runMigrationStateMachine,
  snapshotLineage,
} from './history-search-offline/swap.mjs';
import {
  assertAppStopped as validateStopped,
  assertDiskSpace,
  assertIdentity,
  openSourceFile,
  removeClosedSidecars,
  validateCandidateFile,
} from './history-search-offline/validation.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const migrationSql = readFileSync(
  resolve(
    repoRoot,
    'src/main/store/migrations/v043_history_search_case_insensitive.sql',
  ),
  'utf8',
);
const openSource = (path, counts = null, identity = null) =>
  openSourceFile(Database, path, counts, identity);
const validateCandidate = (path, counts, exactVersion = null) =>
  validateCandidateFile(Database, path, counts, exactVersion);

function fail(message) {
  throw new Error(message);
}
export function parseArgs(argv) {
  if (argv.includes('--finalize') && argv.includes('--rollback')) {
    fail('--finalize and --rollback are mutually exclusive');
  }
  const result = {
    mode: 'migrate',
    resume: false,
    dbPath: '',
    backupPath: '',
    smokePassed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--resume') result.resume = true;
    else if (arg === '--finalize') result.mode = 'finalize';
    else if (arg === '--rollback') result.mode = 'rollback';
    else if (arg === '--smoke-passed') result.smokePassed = true;
    else if (arg === '--db' || arg === '--backup') {
      const value = argv[++index] ?? '';
      if (!value || value.startsWith('--')) fail(`${arg} requires a path value`);
      if (arg === '--db') result.dbPath = value;
      else result.backupPath = value;
    }
    else fail(`Unknown argument "${arg}". Rerun with only documented flags.`);
  }
  if (!result.dbPath) fail('--db is required');
  if (result.resume && result.mode !== 'migrate') {
    fail('--resume cannot be combined with --finalize or --rollback');
  }
  if (result.mode !== 'finalize' && (result.smokePassed || result.backupPath)) {
    fail('--smoke-passed and --backup are valid only with --finalize');
  }
  return result;
}

function timestamp() {
  return `${new Date().toISOString().replace(/\D/g, '')}-${process.pid}`;
}
function normalizeDbPath(input) {
  const absolute = resolve(input);
  const directory = realpathSync(dirname(absolute));
  return resolve(directory, basename(absolute));
}
async function prepareAndInstall(
  dbPath,
  initialJournal,
  mode,
  startedAt,
  assertStopped,
) {
  const journalRef = { value: initialJournal };
  let preparedIdentity = null;
  const transition = makeReportingTransition(
    dbPath,
    mode,
    startedAt,
    journalRef,
  );
  const paths = resolveLineagePaths(dbPath, journalRef.value);
  await runMigrationStateMachine({
    transition: (state, patch = {}) => transition(
      state,
      state === 'ready'
        ? { ...patch, candidateIdentity: preparedIdentity }
        : patch,
    ),
    operations: {
      preflight: async () => {
        assertStopped(
          [paths.db, paths.candidate, paths.backup],
          [paths.db],
        );
        openSource(
          paths.db,
          journalRef.value.businessCounts,
          journalRef.value.sourceIdentity,
        );
        assertDiskSpace(paths.db, journalRef.value.sourceSize);
      },
      copy: async () => copySource({
        Database,
        paths,
        journal: journalRef.value,
      }),
      migrate: async () => migrateCandidate({
        Database,
        paths,
        journal: journalRef.value,
        migrationSql,
      }),
      validate: async () => {
        validateCandidate(paths.candidate, journalRef.value.businessCounts, 43);
        preparedIdentity = fileIdentity(paths.candidate);
      },
      install: async () => {
        assertStopped(
          [paths.db, paths.candidate, paths.backup],
          [paths.db, paths.candidate],
        );
        openSource(
          paths.db,
          journalRef.value.businessCounts,
          journalRef.value.sourceIdentity,
        );
        assertIdentity(
          paths.candidate,
          journalRef.value.candidateIdentity,
          'Migrated candidate',
        );
        validateCandidate(paths.candidate, journalRef.value.businessCounts, 43);
        installReadyCandidate({ paths, transition, clearSidecars: removeClosedSidecars });
        removeClosedSidecars(paths.db);
      },
    },
  });
  return journalRef.value;
}
async function startMigration(dbPath, startedAt, assertStopped) {
  if (!existsSync(dbPath)) {
    fail('Database does not exist. Pass the exact database path and rerun.');
  }
  if (journalEntryExists(dbPath)) {
    const previous = readJournal(dbPath);
    if (previous.state !== 'rolled-back') {
      fail('A migration journal already exists. Rerun with --resume.');
    }
  }
  assertStopped([dbPath], [dbPath]);
  const businessCounts = openSource(dbPath);
  const sourceIdentity = fileIdentity(dbPath);
  const sourceSize = Number(sourceIdentity.size);
  assertDiskSpace(dbPath, sourceSize);

  const stamp = timestamp();
  const journal = createJournal({
    dbPath,
    sourceIdentity,
    sourceSize,
    businessCounts,
    candidateName: `${basename(dbPath)}.v43-${stamp}.tmp`,
    backupName: `${basename(dbPath)}.${stamp}.bak`,
  });
  const paths = resolveLineagePaths(dbPath, journal);
  if (existsSync(paths.candidate) || existsSync(paths.backup)) {
    fail('Generated migration lineage already exists. Wait and rerun.');
  }
  writeJournal(dbPath, journal);
  reportMigration('migrate', 'preflight', 'running', startedAt);
  await prepareAndInstall(
    dbPath,
    journal,
    'migrate',
    startedAt,
    assertStopped,
  );
}

async function resumeMigration(dbPath, startedAt, assertStopped) {
  const journal = readJournal(dbPath);
  if (journal.state === 'finalized') {
    reportMigration('resume', journal.state, 'success', startedAt);
    return;
  }
  const paths = resolveLineagePaths(dbPath, journal);
  assertStopped(
    [paths.db, paths.candidate, paths.backup, paths.failed],
    [paths.db, paths.backup],
  );
  const kind = classifyLineageSnapshot(
    journal,
    snapshotLineage(paths, journal),
  );
  const journalRef = { value: journal };
  const transition = makeReportingTransition(
    dbPath,
    'resume',
    startedAt,
    journalRef,
  );

  if (kind === 'preparation' || kind === 'source-only') {
    openSource(paths.db, journal.businessCounts, journal.sourceIdentity);
    discardPartialCandidate(paths);
    transition('recovery', {
      candidateIdentity: null,
      failedAt: null,
    });
    await prepareAndInstall(
      dbPath,
      journalRef.value,
      'resume',
      startedAt,
      assertStopped,
    );
    return;
  }
  if (kind === 'ready') {
    openSource(paths.db, journal.businessCounts, journal.sourceIdentity);
    validateCandidate(paths.candidate, journal.businessCounts, 43);
    try {
      installReadyCandidate({ paths, transition, clearSidecars: removeClosedSidecars });
    } catch (error) {
      transition('failed', { failedAt: 'ready' });
      throw error;
    }
    return;
  }
  if (kind === 'source-backed-up') {
    openSource(paths.backup, journal.businessCounts, journal.sourceIdentity);
    validateCandidate(paths.candidate, journal.businessCounts, 43);
    try {
      transition('source-backed-up');
      removeClosedSidecars(paths.db);
      renameSync(paths.candidate, paths.db);
      fsyncDirectory(dirname(paths.db));
      transition('installed-pending-smoke');
    } catch (error) {
      transition('failed', { failedAt: 'source-backed-up' });
      throw error;
    }
    return;
  }
  if (kind === 'installed') {
    openSource(paths.backup, journal.businessCounts, journal.sourceIdentity);
    validateCandidate(paths.db, null);
    transition('installed-pending-smoke');
    return;
  }
  if (kind === 'rolled-back') {
    openSource(paths.db, journal.businessCounts, journal.sourceIdentity);
    transition('rolled-back');
    return;
  }
  if (kind === 'rollback-source-backed-up') {
    fail('Rollback was interrupted. Rerun the same command with --rollback.');
  }
  fail('Backup deletion was interrupted. Rerun with --finalize --smoke-passed.');
}

function rollbackMigration(dbPath, startedAt, assertStopped) {
  let journal = readJournal(dbPath);
  if (journal.state === 'finalized') {
    fail('Migration is already finalized; its rollback backup no longer exists.');
  }
  let paths = resolveLineagePaths(dbPath, journal);
  assertStopped(
    [paths.db, paths.candidate, paths.backup, paths.failed],
    [paths.db, paths.backup],
  );
  let kind = classifyLineageSnapshot(
    journal,
    snapshotLineage(paths, journal),
  );
  if (kind === 'rolled-back') {
    openSource(paths.db, journal.businessCounts, journal.sourceIdentity);
    const journalRef = { value: journal };
    makeReportingTransition(
      dbPath,
      'rollback',
      startedAt,
      journalRef,
    )('rolled-back');
    return;
  }
  if (!['installed', 'source-backed-up', 'rollback-source-backed-up'].includes(kind)) {
    fail('No validated source backup is ready for rollback. Use --resume first.');
  }
  openSource(paths.backup, journal.businessCounts, journal.sourceIdentity);

  if (!journal.failedName) {
    const failedName = `${journal.dbName}.v43-failed-${timestamp()}.db`;
    const journalRef = { value: journal };
    const transition = makeReportingTransition(
      dbPath,
      'rollback',
      startedAt,
      journalRef,
    );
    transition('recovery', { failedName });
    journal = journalRef.value;
    paths = resolveLineagePaths(dbPath, journal);
    if (existsSync(paths.failed)) fail('Failed-candidate preservation path exists.');
    kind = classifyLineageSnapshot(
      journal,
      snapshotLineage(paths, journal),
    );
  }

  const journalRef = { value: journal };
  const transition = makeReportingTransition(
    dbPath,
    'rollback',
    startedAt,
    journalRef,
  );
  const currentCandidatePath =
    kind === 'installed'
      ? paths.db
      : kind === 'source-backed-up'
        ? paths.candidate
        : paths.failed;
  rollbackToSource({
    paths,
    currentCandidatePath,
    transition,
    clearSidecars: removeClosedSidecars,
    validateRestored: () => {
      openSource(paths.db, journal.businessCounts, journal.sourceIdentity);
    },
  });
}

function finalizeMigration(
  dbPath,
  backupArgument,
  smokePassed,
  startedAt,
  assertStopped,
) {
  if (!smokePassed) {
    fail('--smoke-passed is required after a successful app smoke test.');
  }
  const journal = readJournal(dbPath);
  if (journal.state === 'rolled-back') {
    fail('Migration was rolled back and cannot be finalized.');
  }
  const paths = resolveLineagePaths(dbPath, journal);
  if (
    backupArgument &&
    resolve(backupArgument) !== resolve(paths.backup)
  ) {
    fail('--backup does not match the backup bound by the migration journal.');
  }
  assertStopped(
    [paths.db, paths.candidate, paths.backup, paths.failed],
    [paths.db, paths.backup],
  );
  const kind = classifyLineageSnapshot(
    journal,
    snapshotLineage(paths, journal),
  );
  if (!['installed', 'finalized-pending-journal'].includes(kind)) {
    fail('Installed migrated database does not match the journal lineage.');
  }
  validateCandidate(paths.db, null);
  if (existsSync(paths.backup)) {
    openSource(paths.backup, journal.businessCounts, journal.sourceIdentity);
    rmSync(paths.backup);
  }
  removeClosedSidecars(paths.backup);
  fsyncDirectory(dirname(dbPath));
  const journalRef = { value: journal };
  makeReportingTransition(
    dbPath,
    'finalize',
    startedAt,
    journalRef,
  )('finalized');
}

export async function runCli(argv, runtime = {}) {
  const startedAt = performance.now();
  const args = parseArgs(argv);
  const dbPath = normalizeDbPath(args.dbPath);
  const assertStopped = (paths, probes) =>
    validateStopped(Database, paths, probes, runtime);
  if (args.mode === 'finalize') {
    finalizeMigration(
      dbPath,
      args.backupPath,
      args.smokePassed,
      startedAt,
      assertStopped,
    );
  } else if (args.mode === 'rollback') {
    rollbackMigration(dbPath, startedAt, assertStopped);
  } else if (args.resume) {
    await resumeMigration(dbPath, startedAt, assertStopped);
  } else {
    await startMigration(dbPath, startedAt, assertStopped);
  }
}

export function safeErrorMessage(error, dbArgument) {
  const message = error instanceof Error ? error.message : 'Unknown migration failure';
  if (!dbArgument) return message;
  const databasePaths = [resolve(dbArgument)];
  try {
    databasePaths.push(normalizeDbPath(dbArgument));
  } catch {
    // Redact the lexical path even when its parent cannot be resolved.
  }
  const replacements = [
    ...databasePaths.map((path) => [path, '<database>']),
    ...databasePaths.map((path) => [dirname(path), '<database-directory>']),
  ].sort(([left], [right]) => right.length - left.length);
  return replacements.reduce(
    (redacted, [path, replacement]) =>
      redacted.replaceAll(path, replacement),
    message,
  );
}

function retryHint(argv, dbArgument) {
  if (argv.includes('--rollback')) return ' Rerun the same --rollback command.';
  if (argv.includes('--finalize')) return ' Rerun the same --finalize command.';
  if (argv.includes('--resume')) return ' Rerun the same --resume command.';
  try {
    if (dbArgument && journalEntryExists(normalizeDbPath(dbArgument))) {
      return ' Rerun the same command with --resume.';
    }
  } catch {
    // The primary error already explains an invalid or unavailable path.
  }
  return ' Correct the cause, then rerun the same command.';
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const argv = process.argv.slice(2);
  try {
    await runCli(argv);
  } catch (error) {
    const dbIndex = argv.indexOf('--db');
    console.error(
      `[history-search-migration] ${safeErrorMessage(
        error,
        dbIndex >= 0 ? argv[dbIndex + 1] : '',
      )}${retryHint(argv, dbIndex >= 0 ? argv[dbIndex + 1] : '')}`,
    );
    process.exitCode = 1;
  }
}
