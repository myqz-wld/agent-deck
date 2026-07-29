import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  fileIdentity,
  sameFileIdentity,
} from './journal.mjs';
import {
  assertIdentity,
  removeClosedSidecars,
  validateSourceV42,
} from './validation.mjs';

function fail(message) {
  throw new Error(message);
}

export function fsyncDirectory(path, io = {
  closeSync,
  fsyncSync,
  openSync,
}) {
  const fd = io.openSync(path, 'r');
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

function identityKind(identity, journal) {
  if (identity === null) return 'missing';
  if (sameFileIdentity(identity, journal.sourceIdentity)) return 'source';
  if (
    journal.candidateIdentity &&
    sameFileIdentity(identity, journal.candidateIdentity)
  ) {
    return 'candidate';
  }
  return 'unknown';
}

export function classifyLineageSnapshot(journal, snapshot) {
  const kinds = Object.fromEntries(
    Object.entries(snapshot).map(([name, identity]) => [
      name,
      identityKind(identity, journal),
    ]),
  );
  if (!journal.candidateIdentity) {
    if (
      kinds.db === 'source' &&
      kinds.backup === 'missing' &&
      kinds.failed === 'missing'
    ) {
      return 'preparation';
    }
    fail('migration lineage moved before a candidate identity was recorded');
  }
  if (Object.values(kinds).includes('unknown')) {
    fail('migration file combination does not match recorded lineage');
  }

  if (
    kinds.db === 'source' &&
    kinds.backup === 'missing' &&
    kinds.candidate === 'candidate' &&
    kinds.failed === 'missing'
  ) {
    return 'ready';
  }
  if (
    kinds.db === 'source' &&
    kinds.backup === 'missing' &&
    kinds.candidate === 'missing' &&
    kinds.failed === 'missing'
  ) {
    return 'source-only';
  }
  if (
    kinds.db === 'missing' &&
    kinds.backup === 'source' &&
    kinds.candidate === 'candidate' &&
    kinds.failed === 'missing'
  ) {
    return 'source-backed-up';
  }
  if (
    kinds.db === 'candidate' &&
    kinds.backup === 'source' &&
    kinds.candidate === 'missing' &&
    kinds.failed === 'missing'
  ) {
    return 'installed';
  }
  if (
    kinds.db === 'candidate' &&
    kinds.backup === 'missing' &&
    kinds.candidate === 'missing' &&
    kinds.failed === 'missing'
  ) {
    return 'finalized-pending-journal';
  }
  if (
    kinds.db === 'missing' &&
    kinds.backup === 'source' &&
    kinds.candidate === 'missing' &&
    kinds.failed === 'candidate'
  ) {
    return 'rollback-source-backed-up';
  }
  if (
    kinds.db === 'source' &&
    kinds.backup === 'missing' &&
    kinds.candidate === 'missing' &&
    kinds.failed === 'candidate'
  ) {
    return 'rolled-back';
  }
  fail('migration file combination is ambiguous for recorded lineage');
}

export function snapshotLineage(paths, journal, io = {
  existsSync,
  lstatSync,
}) {
  const identityAt = (path) => {
    if (!path || !io.existsSync(path)) return null;
    return fileIdentity(path, io);
  };
  return {
    db: identityAt(paths.db),
    candidate: identityAt(paths.candidate),
    backup: identityAt(paths.backup),
    failed: identityAt(paths.failed),
  };
}

export function installReadyCandidate({
  paths,
  transition,
  clearSidecars = () => {},
  renameSync: rename = renameSync,
  fsyncDirectory: syncDirectory = fsyncDirectory,
}) {
  clearSidecars(paths.db);
  clearSidecars(paths.backup);
  rename(paths.db, paths.backup);
  syncDirectory(dirname(paths.db));
  transition('source-backed-up');
  rename(paths.candidate, paths.db);
  syncDirectory(dirname(paths.db));
  transition('installed-pending-smoke');
}

export function rollbackToSource({
  paths,
  currentCandidatePath,
  validateRestored = () => {},
  transition,
  clearSidecars = () => {},
  renameSync: rename = renameSync,
  fsyncDirectory: syncDirectory = fsyncDirectory,
}) {
  transition('recovery');
  clearSidecars(paths.db);
  clearSidecars(paths.backup);
  if (paths.failed) clearSidecars(paths.failed);
  if (currentCandidatePath && currentCandidatePath !== paths.failed) {
    rename(currentCandidatePath, paths.failed);
    syncDirectory(dirname(paths.db));
  }
  rename(paths.backup, paths.db);
  syncDirectory(dirname(paths.db));
  validateRestored(paths.db);
  transition('rolled-back');
}

export async function runMigrationStateMachine({ transition, operations }) {
  let failedAt = 'preflight';
  try {
    for (const state of ['preflight', 'copy', 'migrate', 'validate']) {
      failedAt = state;
      transition(state);
      await operations[state]();
    }
    failedAt = 'ready';
    transition('ready');
    await operations.install();
  } catch (error) {
    transition('failed', { failedAt });
    throw error;
  }
}

export async function copySource({ Database, paths, journal }) {
  const source = new Database(paths.db, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    validateSourceV42(source, journal.businessCounts);
    await source.backup(paths.candidate, {
      progress: () => 4096,
    });
  } finally {
    source.close();
  }
  assertIdentity(paths.db, journal.sourceIdentity, 'Source database', true);
}

export function migrateCandidate({
  Database,
  paths,
  journal,
  migrationSql,
}) {
  const copy = new Database(paths.candidate, { fileMustExist: true });
  try {
    copy.pragma('foreign_keys = ON');
    copy.pragma('trusted_schema = ON');
    validateSourceV42(copy, journal.businessCounts);
    copy.pragma('journal_mode = WAL');
    copy.pragma('synchronous = FULL');
    copy.transaction(() => {
      copy.exec(migrationSql);
      copy.pragma('user_version = 43');
    })();
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
  removeClosedSidecars(paths.candidate);
}

export function discardPartialCandidate(paths) {
  if (existsSync(paths.candidate)) rmSync(paths.candidate);
  removeClosedSidecars(paths.candidate);
  fsyncDirectory(dirname(paths.db));
}
