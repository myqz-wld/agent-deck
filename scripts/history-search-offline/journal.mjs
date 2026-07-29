import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const JOURNAL_SUFFIX = '.migration-v43.json';
export const JOURNAL_MAX_BYTES = 64 * 1024;
export const JOURNAL_STATES = Object.freeze([
  'preflight',
  'copy',
  'migrate',
  'validate',
  'ready',
  'source-backed-up',
  'installed-pending-smoke',
  'finalized',
  'failed',
  'recovery',
  'rolled-back',
]);
export const COMPLETED_JOURNAL_STATES = new Set(['finalized', 'rolled-back']);
export const STARTUP_SAFE_JOURNAL_STATES = new Set([
  'installed-pending-smoke',
  'finalized',
  'rolled-back',
]);

const defaultIo = {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
};

function fail(message) {
  throw new Error(message);
}

function assertIdentity(identity, label) {
  if (
    !identity ||
    typeof identity.device !== 'string' ||
    identity.device.length === 0 ||
    typeof identity.inode !== 'string' ||
    identity.inode.length === 0
  ) {
    fail(`${label} identity is missing or invalid`);
  }
}

function assertSafeName(name, label) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    basename(name) !== name ||
    name === '.' ||
    name === '..'
  ) {
    fail(`${label} must be a safe basename`);
  }
}

export function assertValidJournal(journal) {
  if (!journal || typeof journal !== 'object') fail('migration journal is invalid');
  if (journal.formatVersion !== 1) fail('unsupported migration journal format');
  if (journal.migrationVersion !== 43) fail('migration journal targets the wrong version');
  if (journal.command !== 'migrate:history-search') {
    fail('migration journal command does not match');
  }
  if (!JOURNAL_STATES.includes(journal.state)) fail('unknown journal state');
  assertSafeName(journal.dbName, 'database name');
  assertSafeName(journal.candidateName, 'candidate name');
  assertSafeName(journal.backupName, 'backup name');
  if (
    journal.dbName === journal.candidateName ||
    journal.dbName === journal.backupName ||
    journal.candidateName === journal.backupName
  ) {
    fail('migration journal lineage names must be distinct');
  }
  if (journal.failedName !== null) {
    assertSafeName(journal.failedName, 'failed candidate name');
    if (
      journal.failedName === journal.dbName ||
      journal.failedName === journal.candidateName ||
      journal.failedName === journal.backupName
    ) {
      fail('failed candidate name must be distinct');
    }
  }
  assertIdentity(journal.sourceIdentity, 'source');
  if (journal.candidateIdentity !== null) {
    assertIdentity(journal.candidateIdentity, 'candidate');
  }
  if (
    typeof journal.sourceSize !== 'number' ||
    !Number.isSafeInteger(journal.sourceSize) ||
    journal.sourceSize < 0
  ) {
    fail('migration journal source size is invalid');
  }
  if (
    journal.sourceIdentity.size !== String(journal.sourceSize) ||
    typeof journal.sourceIdentity.modifiedMs !== 'string' ||
    journal.sourceIdentity.modifiedMs.length === 0
  ) {
    fail('migration journal source fingerprint is invalid');
  }
  if (!journal.businessCounts || typeof journal.businessCounts !== 'object') {
    fail('migration journal business counts are missing');
  }
  for (const [table, count] of Object.entries(journal.businessCounts)) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(table) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      fail('migration journal business counts are invalid');
    }
  }
  if (
    typeof journal.createdAt !== 'string' ||
    typeof journal.updatedAt !== 'string'
  ) {
    fail('migration journal timestamps are missing');
  }
  return journal;
}

export function journalPathFor(dbPath) {
  return `${dbPath}${JOURNAL_SUFFIX}`;
}

export function journalEntryExists(dbPath, io = defaultIo) {
  try {
    io.lstatSync(journalPathFor(dbPath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('migration journal cannot be inspected; restore it, then rerun with --resume');
  }
}

export function createJournal({
  dbPath,
  sourceIdentity,
  sourceSize,
  businessCounts,
  candidateName,
  backupName,
  now = new Date().toISOString(),
}) {
  return assertValidJournal({
    formatVersion: 1,
    migrationVersion: 43,
    command: 'migrate:history-search',
    dbName: basename(dbPath),
    candidateName,
    backupName,
    failedName: null,
    sourceIdentity,
    candidateIdentity: null,
    sourceSize,
    businessCounts,
    state: 'preflight',
    failedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function writeJournal(dbPath, journal, io = defaultIo) {
  assertValidJournal(journal);
  const journalPath = journalPathFor(dbPath);
  const temporaryPath = `${journalPath}.tmp`;
  io.writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const fileFd = io.openSync(temporaryPath, 'r');
  try {
    io.fsyncSync(fileFd);
  } finally {
    io.closeSync(fileFd);
  }
  io.renameSync(temporaryPath, journalPath);
  const directoryFd = io.openSync(dirname(journalPath), 'r');
  try {
    io.fsyncSync(directoryFd);
  } finally {
    io.closeSync(directoryFd);
  }
}

export function transitionJournal(
  dbPath,
  journal,
  state,
  patch = {},
  io = defaultIo,
) {
  if (!JOURNAL_STATES.includes(state)) fail(`unknown journal state: ${state}`);
  const next = assertValidJournal({
    ...journal,
    ...patch,
    state,
    updatedAt: new Date().toISOString(),
  });
  writeJournal(dbPath, next, io);
  return next;
}

export function reportMigration(
  mode,
  state,
  outcome,
  startedAt,
  write = console.log,
) {
  write(JSON.stringify({
    version: 43,
    mode,
    state,
    outcome,
    durationMs: Math.round(performance.now() - startedAt),
  }));
}

export function makeReportingTransition(
  dbPath,
  mode,
  startedAt,
  journalRef,
) {
  return (state, patch = {}) => {
    journalRef.value = transitionJournal(
      dbPath,
      journalRef.value,
      state,
      patch,
    );
    reportMigration(
      mode,
      state,
      state === 'installed-pending-smoke' ||
        state === 'finalized' ||
        state === 'rolled-back'
        ? 'success'
        : state === 'failed'
          ? 'failed'
          : 'running',
      startedAt,
    );
  };
}

export function readJournal(dbPath, io = defaultIo) {
  const journalPath = journalPathFor(dbPath);
  let stats;
  try {
    stats = io.lstatSync(journalPath);
  } catch {
    fail('migration journal cannot be inspected; restore it, then rerun with --resume');
  }
  if (!stats.isFile()) {
    fail('migration journal must be a regular file; restore it, then rerun with --resume');
  }
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    stats.size > JOURNAL_MAX_BYTES
  ) {
    fail('migration journal exceeds the 64 KiB safety limit; restore it, then rerun with --resume');
  }
  let parsed;
  try {
    parsed = JSON.parse(io.readFileSync(journalPath, 'utf8'));
  } catch {
    fail('migration journal cannot be read; restore it, then rerun with --resume');
  }
  try {
    return assertValidJournal(parsed);
  } catch {
    fail('migration journal is invalid; restore it, then rerun with --resume');
  }
}

export function fileIdentity(path, io = defaultIo) {
  const stats = io.lstatSync(path);
  if (!stats.isFile()) fail('migration lineage path is not a regular file');
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    size: String(stats.size),
    modifiedMs: String(stats.mtimeMs),
  };
}

export function sameFileIdentity(left, right) {
  return Boolean(
    left &&
    right &&
    left.device === right.device &&
    left.inode === right.inode,
  );
}

export function sameSourceIdentity(left, right) {
  return Boolean(
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs,
  );
}

export function resolveLineagePaths(dbPath, journal) {
  assertValidJournal(journal);
  if (basename(dbPath) !== journal.dbName) {
    fail('migration journal is bound to a different database name');
  }
  const directory = dirname(dbPath);
  const lineagePath = (name) => {
    const path = resolve(directory, name);
    if (dirname(path) !== directory) fail('migration lineage escapes database directory');
    return path;
  };
  return {
    db: dbPath,
    candidate: lineagePath(journal.candidateName),
    backup: lineagePath(journal.backupName),
    failed: journal.failedName ? lineagePath(journal.failedName) : null,
  };
}
