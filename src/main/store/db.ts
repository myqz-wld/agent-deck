import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { MIGRATIONS, type Migration } from './migrations';
import log from '@main/utils/logger';

const logger = log.scope('store-db');
const DB_NAME = 'agent-deck.db';
const OFFLINE_JOURNAL_SUFFIX = '.migration-v43.json';
const OFFLINE_JOURNAL_MAX_BYTES = 64 * 1024;
const STARTUP_SAFE_OFFLINE_STATES = new Set([
  'installed-pending-smoke',
  'finalized',
  'rolled-back',
]);

let dbInstance: Database.Database | null = null;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface DatabaseInspection {
  existed: boolean;
  userVersion: number;
  schemaObjectCount: number;
  fresh: boolean;
}

type OfflineMigration = Extract<Migration, { execution: 'offline' }>;

interface MigrationPlan {
  migrations: Migration[];
  blocked: OfflineMigration | null;
}

export class OfflineMigrationRequiredError extends Error {
  readonly code = 'OFFLINE_MIGRATION_REQUIRED';

  constructor(
    readonly currentVersion: number,
    readonly targetVersion: number,
    readonly command: string,
    dbPath: string,
  ) {
    super(
      `Agent Deck database v${currentVersion} requires offline migration V${targetVersion}. ` +
      `Fully quit Agent Deck, run \`pnpm ${command} -- --db ${shellQuote(dbPath)}\`, ` +
      'then restart Agent Deck.',
    );
    this.name = 'OfflineMigrationRequiredError';
  }
}

function schemaObjectCount(db: Database.Database): number {
  return Number(db.prepare(
    'SELECT count(*) FROM sqlite_schema',
  ).pluck().get());
}

function inspectDatabase(dbPath: string): DatabaseInspection {
  if (!existsSync(dbPath)) {
    return {
      existed: false,
      userVersion: 0,
      schemaObjectCount: 0,
      fresh: true,
    };
  }

  const inspected = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const userVersion =
      (inspected.pragma('user_version', { simple: true }) as number) ?? 0;
    const objects = schemaObjectCount(inspected);
    if (userVersion === 0 && objects > 0) {
      throw new Error(
        `Existing Agent Deck database has user_version=0 but is not empty (${objects} schema objects). ` +
        'Refusing to initialize over partial or unversioned state.',
      );
    }
    return {
      existed: true,
      userVersion,
      schemaObjectCount: objects,
      fresh: userVersion === 0 && objects === 0,
    };
  } finally {
    inspected.close();
  }
}

function readOfflineJournalState(dbPath: string): string | null {
  const journalPath = `${dbPath}${OFFLINE_JOURNAL_SUFFIX}`;
  let stats;
  try {
    stats = lstatSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw offlineJournalRecoveryError(
      dbPath,
      'cannot be inspected',
    );
  }
  if (!stats.isFile()) {
    throw offlineJournalRecoveryError(
      dbPath,
      'must be a regular file',
    );
  }
  if (stats.size > OFFLINE_JOURNAL_MAX_BYTES) {
    throw offlineJournalRecoveryError(
      dbPath,
      'exceeds the 64 KiB safety limit',
    );
  }
  try {
    const value = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      formatVersion?: unknown;
      migrationVersion?: unknown;
      state?: unknown;
    };
    if (
      value.formatVersion !== 1 ||
      value.migrationVersion !== 43 ||
      typeof value.state !== 'string'
    ) {
      return 'invalid';
    }
    return value.state;
  } catch {
    return 'invalid';
  }
}

function offlineJournalRecoveryError(dbPath: string, reason: string): Error {
  return new Error(
    `Offline history-search migration journal ${reason}. ` +
    `Fully quit Agent Deck, restore the original journal, then run ` +
    `\`pnpm migrate:history-search -- --db ${shellQuote(dbPath)} --resume\`.`,
  );
}

function assertNoActiveOfflineJournal(dbPath: string): void {
  const state = readOfflineJournalState(dbPath);
  if (
    state === null ||
    (STARTUP_SAFE_OFFLINE_STATES.has(state) &&
      (state === 'finalized' || existsSync(dbPath)))
  ) {
    return;
  }
  throw new Error(
    `Offline history-search migration journal is in state "${state}". ` +
    `Fully quit Agent Deck, run \`pnpm migrate:history-search -- --db ${shellQuote(dbPath)} --resume\`, ` +
    'then restart Agent Deck.',
  );
}

function pendingMigrations(userVersion: number): Migration[] {
  return MIGRATIONS
    .filter((migration) => migration.version > userVersion)
    .sort((a, b) => a.version - b.version);
}

function planMigrations(
  inspection: DatabaseInspection,
): MigrationPlan {
  const migrations: Migration[] = [];
  let expectedVersion = inspection.userVersion + 1;
  for (const migration of pendingMigrations(inspection.userVersion)) {
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration registry is not contiguous at V${expectedVersion}.`,
      );
    }
    if (
      migration.execution === 'offline' &&
      !(inspection.fresh && migration.freshInstallSafe)
    ) {
      return { migrations, blocked: migration };
    }
    migrations.push(migration);
    expectedVersion += 1;
  }
  return { migrations, blocked: null };
}

function assertInspectionUnchanged(
  before: DatabaseInspection,
  opened: Database.Database,
): void {
  const currentVersion =
    (opened.pragma('user_version', { simple: true }) as number) ?? 0;
  const currentObjectCount = schemaObjectCount(opened);
  if (
    currentVersion !== before.userVersion ||
    currentObjectCount !== before.schemaObjectCount
  ) {
    throw new Error(
      'Agent Deck database changed between read-only inspection and writable open. ' +
      'Fully quit every Agent Deck process and retry.',
    );
  }
}

// Distinguishes explicit shutdown from a missing initDb() call.
let dbClosed = false;

export function initDb(): Database.Database {
  if (dbInstance) return dbInstance;
  dbClosed = false;

  const startedAt = performance.now();
  const userDataDir = app.getPath('userData');
  const dbPath = join(userDataDir, DB_NAME);
  let inspection: DatabaseInspection | null = null;
  let opened: Database.Database | null = null;
  let published = false;
  let initializationState = 'journal-check';
  let effectiveVersion: number | null = null;

  try {
    // Recovery metadata wins over a missing DB path after an interrupted swap.
    assertNoActiveOfflineJournal(dbPath);
    initializationState = 'inspect';
    mkdirSync(userDataDir, { recursive: true });
    inspection = inspectDatabase(dbPath);
    effectiveVersion = inspection.userVersion;
    const plan = planMigrations(inspection);
    if (plan.blocked && plan.migrations.length === 0) {
      throw new OfflineMigrationRequiredError(
        inspection.userVersion,
        plan.blocked.version,
        plan.blocked.command,
        dbPath,
      );
    }

    initializationState = 'open-recheck';
    opened = new Database(dbPath);
    // Recheck before WAL mode or a transaction to catch inspect/open races.
    assertInspectionUnchanged(inspection, opened);
    opened.pragma('journal_mode = WAL');
    opened.pragma('foreign_keys = ON');
    // FTS triggers write virtual tables and require a trusted schema.
    opened.pragma('trusted_schema = ON');

    if (plan.migrations.length > 0) {
      initializationState = 'migrate';
      const tx = opened.transaction(() => {
        for (const migration of plan.migrations) {
          opened!.exec(migration.sql);
          opened!.pragma(`user_version = ${migration.version}`);
        }
      });
      tx();
      effectiveVersion = plan.migrations.at(-1)!.version;
    }

    if (plan.blocked) {
      initializationState = 'offline-required';
      throw new OfflineMigrationRequiredError(
        effectiveVersion,
        plan.blocked.version,
        plan.blocked.command,
        dbPath,
      );
    }

    dbInstance = opened;
    published = true;
    logger.info('migration initialization', {
      version: effectiveVersion,
      mode: inspection.fresh ? 'fresh-startup' : 'startup',
      state: 'complete',
      outcome: 'success',
      durationMs: Math.round(performance.now() - startedAt),
    });
    return opened;
  } catch (error) {
    logger.warn('migration initialization', {
      version: effectiveVersion,
      mode:
        error instanceof OfflineMigrationRequiredError
          ? 'offline-required'
          : 'startup',
      state: initializationState,
      outcome:
        error instanceof OfflineMigrationRequiredError
          ? 'blocked'
          : opened
            ? 'failed'
            : 'blocked',
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  } finally {
    if (opened && !published) {
      try {
        opened.close();
      } catch {
        try {
          logger.warn('migration connection close failed', {
            version: effectiveVersion,
            mode: 'startup',
            state: 'close',
            outcome: 'failed',
            durationMs: Math.round(performance.now() - startedAt),
          });
        } catch {
          // Diagnostics must not replace the primary initialization error.
        }
      }
    }
  }
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

/** True only after an explicit closeDb(), not before initial startup. */
export function isDbClosed(): boolean {
  return dbClosed;
}

export function closeDb(): void {
  dbClosed = true;
  if (dbInstance) {
    try {
      dbInstance.close();
    } finally {
      dbInstance = null;
    }
  }
}
