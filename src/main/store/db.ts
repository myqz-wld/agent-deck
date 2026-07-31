import Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import log from '@main/utils/logger';
import { CURRENT_SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from './schema';

const logger = log.scope('store-db');
const DB_NAME = 'agent-deck.db';

let dbInstance: Database.Database | null = null;
// Distinguishes explicit shutdown from a missing initDb() call.
let dbClosed = false;

interface DatabaseInspection {
  userVersion: number;
  schemaObjectCount: number;
  schemaFingerprint: string;
  fresh: boolean;
}

export class UnsupportedDatabaseVersionError extends Error {
  readonly code = 'UNSUPPORTED_DATABASE_VERSION';

  constructor(readonly currentVersion: number) {
    super(
      `Agent Deck database schema v${currentVersion} is unsupported; ` +
        `the current test build requires v${CURRENT_SCHEMA_VERSION}. Delete the test database and restart.`,
    );
    this.name = 'UnsupportedDatabaseVersionError';
  }
}

function schemaObjectCount(db: Database.Database): number {
  return Number(db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get());
}

function schemaFingerprint(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
      FROM sqlite_schema
     ORDER BY type, name
  `).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const EMPTY_SCHEMA_FINGERPRINT = createHash('sha256')
  .update('[]')
  .digest('hex');
let expectedSchemaFingerprint: string | null = null;

function currentSchemaFingerprint(): string {
  if (expectedSchemaFingerprint) return expectedSchemaFingerprint;
  const baseline = new Database(':memory:');
  try {
    baseline.pragma('trusted_schema = ON');
    baseline.exec(CURRENT_SCHEMA_SQL);
    expectedSchemaFingerprint = schemaFingerprint(baseline);
    return expectedSchemaFingerprint;
  } finally {
    baseline.close();
  }
}

function inspectDatabase(dbPath: string): DatabaseInspection {
  if (!existsSync(dbPath)) {
    return {
      userVersion: 0,
      schemaObjectCount: 0,
      schemaFingerprint: EMPTY_SCHEMA_FINGERPRINT,
      fresh: true,
    };
  }

  const inspected = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const userVersion =
      (inspected.pragma('user_version', { simple: true }) as number) ?? 0;
    const objects = schemaObjectCount(inspected);
    const fingerprint = schemaFingerprint(inspected);
    if (userVersion === 0 && objects > 0) {
      throw new Error(
        `Existing Agent Deck database has user_version=0 but is not empty (${objects} schema objects). ` +
          'Delete the partial test database and restart.',
      );
    }
    if (userVersion !== 0 && userVersion !== CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedDatabaseVersionError(userVersion);
    }
    if (userVersion === CURRENT_SCHEMA_VERSION && objects === 0) {
      throw new Error('Current-version Agent Deck database has no schema objects.');
    }
    if (
      userVersion === CURRENT_SCHEMA_VERSION &&
      fingerprint !== currentSchemaFingerprint()
    ) {
      throw new Error(
        `Current-version Agent Deck database does not match the v${CURRENT_SCHEMA_VERSION} schema baseline. ` +
          'Delete the partial test database and restart.',
      );
    }
    return {
      userVersion,
      schemaObjectCount: objects,
      schemaFingerprint: fingerprint,
      fresh: userVersion === 0,
    };
  } finally {
    inspected.close();
  }
}

function assertInspectionUnchanged(
  before: DatabaseInspection,
  opened: Database.Database,
): void {
  const currentVersion =
    (opened.pragma('user_version', { simple: true }) as number) ?? 0;
  const currentObjectCount = schemaObjectCount(opened);
  const currentFingerprint = schemaFingerprint(opened);
  if (
    currentVersion !== before.userVersion ||
    currentObjectCount !== before.schemaObjectCount ||
    currentFingerprint !== before.schemaFingerprint
  ) {
    throw new Error(
      'Agent Deck database changed between read-only inspection and writable open. ' +
        'Fully quit every Agent Deck process and retry.',
    );
  }
}

export function initDb(): Database.Database {
  if (dbInstance) return dbInstance;
  dbClosed = false;

  const startedAt = performance.now();
  const userDataDir = app.getPath('userData');
  const dbPath = join(userDataDir, DB_NAME);
  let opened: Database.Database | null = null;
  let published = false;
  let mode: 'fresh' | 'existing' = 'existing';
  let state = 'inspect';

  try {
    mkdirSync(userDataDir, { recursive: true });
    const inspection = inspectDatabase(dbPath);
    mode = inspection.fresh ? 'fresh' : 'existing';

    state = 'open-recheck';
    opened = new Database(dbPath);
    assertInspectionUnchanged(inspection, opened);
    opened.pragma('journal_mode = WAL');
    opened.pragma('foreign_keys = ON');
    // FTS triggers write virtual tables and require a trusted schema.
    opened.pragma('trusted_schema = ON');

    if (inspection.fresh) {
      state = 'create-schema';
      opened.transaction(() => {
        opened!.exec(CURRENT_SCHEMA_SQL);
        opened!.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
      })();
    }

    dbInstance = opened;
    published = true;
    logger.info('schema initialization', {
      version: CURRENT_SCHEMA_VERSION,
      mode,
      state: 'complete',
      outcome: 'success',
      durationMs: Math.round(performance.now() - startedAt),
    });
    return opened;
  } catch (error) {
    const versionError =
      error instanceof UnsupportedDatabaseVersionError ? error : null;
    logger.warn('schema initialization', {
      version: CURRENT_SCHEMA_VERSION,
      mode,
      state,
      outcome: opened ? 'failed' : 'blocked',
      failureKind: versionError
        ? 'unsupported-database-version'
        : 'initialization-failed',
      errorCode: versionError?.code ?? null,
      currentVersion: versionError?.currentVersion ?? null,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  } finally {
    if (opened && !published) {
      try {
        opened.close();
      } catch {
        try {
          logger.warn('schema connection close failed', {
            version: CURRENT_SCHEMA_VERSION,
            mode,
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

/** Test/bootstrap-safe readiness probe; production callers still use getDb() for fail-loud access. */
export function isDbInitialized(): boolean {
  return dbInstance !== null;
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
