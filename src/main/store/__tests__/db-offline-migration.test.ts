import Database from 'better-sqlite3';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'logs') return '/tmp';
      if (name === 'userData') return paths.userData;
      throw new Error(`Unexpected Electron path: ${name}`);
    },
    setName: vi.fn(),
    isPackaged: false,
    exit: vi.fn(),
  },
}));

import {
  OfflineMigrationRequiredError,
  closeDb,
  getDb,
  initDb,
} from '../db';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';
import {
  openSourceFile,
} from '../../../../scripts/history-search-offline/validation.mjs';

const DB_NAME = 'agent-deck.db';
const JOURNAL_SUFFIX = '.migration-v43.json';

function dbPath(): string {
  return join(paths.userData, DB_NAME);
}

function makeDbAtVersion(version: number): void {
  const db = new Database(dbPath());
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    for (const migration of MIGRATIONS) {
      if (migration.version > version) break;
      db.exec(migration.sql);
    }
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function readVersion(): number {
  const db = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

function readJournalMode(): string {
  const db = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    return String(db.pragma('journal_mode', { simple: true }));
  } finally {
    db.close();
  }
}

describe.skipIf(!bindingAvailable)('initDb offline migration boundary', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(join(tmpdir(), 'agent-deck-db-offline-'));
  });

  afterEach(() => {
    closeDb();
    rmSync(paths.userData, { recursive: true, force: true });
  });

  it('runs every migration, including fresh-install-safe V43, for a missing database', () => {
    const db = initDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS.at(-1)!.version,
    );
    expect(String(db.prepare(
      `SELECT sql FROM sqlite_schema WHERE name = 'event_search_fts_v1'`,
    ).pluck().get())).toContain('trigram case_sensitive 0');
  });

  it('treats an existing, completely empty user_version=0 database as fresh', () => {
    new Database(dbPath()).close();

    const db = initDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS.at(-1)!.version,
    );
  });

  it('rejects an existing V42 database before changing the database or WAL mode', () => {
    makeDbAtVersion(42);

    expect(() => initDb()).toThrow(OfflineMigrationRequiredError);
    expect(() => initDb()).toThrow(/migrate:history-search/);
    expect(readVersion()).toBe(42);
    expect(readJournalMode()).toBe('delete');
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);
  });

  it.each([41, 1])(
    'atomically advances existing V%i through V42 before requiring offline V43',
    (version) => {
      makeDbAtVersion(version);

      let error: unknown;
      try {
        initDb();
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OfflineMigrationRequiredError);
      expect(error).toMatchObject({
        currentVersion: 42,
        targetVersion: 43,
        command: 'migrate:history-search',
      });
      expect(readVersion()).toBe(42);
      expect(() => openSourceFile(Database, dbPath())).not.toThrow();
      expect(() => getDb()).toThrow(/not initialized/i);
    },
  );

  it('rolls back a failed pre-offline startup prefix to its original version', () => {
    makeDbAtVersion(41);
    const v42 = MIGRATIONS.find((migration) => migration.version === 42)!;
    const originalSql = v42.sql;
    v42.sql = `
      CREATE TABLE prefix_transaction_probe(id INTEGER PRIMARY KEY);
      THIS IS NOT VALID SQL;
    `;
    try {
      expect(() => initDb()).toThrow(/syntax error/i);
    } finally {
      v42.sql = originalSql;
    }

    expect(readVersion()).toBe(41);
    const verify = new Database(dbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(verify.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name = 'prefix_transaction_probe'`,
      ).pluck().get()).toBeUndefined();
    } finally {
      verify.close();
    }
    expect(() => getDb()).toThrow(/not initialized/i);
  });

  it('runs only later startup migrations for an existing V43 database', () => {
    makeDbAtVersion(43);

    const db = initDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS.at(-1)!.version,
    );
    expect(db.prepare(
      `SELECT 1 FROM pragma_table_info('sessions')
       WHERE name = 'hidden_from_history'`,
    ).get()).toBeDefined();
  });

  it('allows installed-pending-smoke to start and apply migrations through V54', () => {
    makeDbAtVersion(43);
    writeFileSync(`${dbPath()}${JOURNAL_SUFFIX}`, JSON.stringify({
      formatVersion: 1,
      migrationVersion: 43,
      state: 'installed-pending-smoke',
    }));

    const db = initDb();
    expect(db.pragma('user_version', { simple: true })).toBe(54);
  });

  it('rejects a partial existing user_version=0 database without altering it', () => {
    const partial = new Database(dbPath());
    partial.exec('CREATE TABLE partial_state(id INTEGER PRIMARY KEY)');
    partial.close();

    expect(() => initDb()).toThrow(/user_version=0.*not empty/i);
    expect(readVersion()).toBe(0);
    const verify = new Database(dbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(verify.prepare(
        `SELECT name FROM sqlite_schema WHERE name = 'partial_state'`,
      ).pluck().get()).toBe('partial_state');
    } finally {
      verify.close();
    }
  });

  it('does not call a V0 database fresh when sqlite_schema contains only internal state', () => {
    const partial = new Database(dbPath());
    partial.exec(`
      CREATE TABLE discarded(id INTEGER PRIMARY KEY AUTOINCREMENT);
      DROP TABLE discarded;
    `);
    expect(partial.prepare(
      `SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'`,
    ).pluck().get()).toBe('sqlite_sequence');
    partial.close();

    expect(() => initDb()).toThrow(/user_version=0.*not empty/i);
    expect(readVersion()).toBe(0);
  });

  it('closes its local connection when a migration fails before publication', () => {
    const last = MIGRATIONS.at(-1)!;
    const originalSql = last.sql;
    last.sql = 'THIS IS NOT VALID SQL';
    try {
      expect(() => initDb()).toThrow();
    } finally {
      last.sql = originalSql;
    }

    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);
  });

  it('preserves the primary initialization error when local close also fails', () => {
    const last = MIGRATIONS.at(-1)!;
    const originalSql = last.sql;
    const originalClose = Database.prototype.close;
    last.sql = 'PRIMARY MIGRATION FAILURE';
    const closeSpy = vi.spyOn(Database.prototype, 'close').mockImplementation(
      function closeWithSecondaryFailure(this: Database.Database) {
        originalClose.call(this);
        throw new Error('secondary close failure');
      },
    );

    let error: unknown;
    try {
      initDb();
    } catch (caught) {
      error = caught;
    } finally {
      last.sql = originalSql;
      closeSpy.mockRestore();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/syntax error/i);
    expect((error as Error).message).not.toContain('secondary close failure');
    expect(() => getDb()).toThrow(/not initialized/i);
  });

  it('checks the fixed offline journal before treating a missing DB as fresh', () => {
    writeFileSync(`${dbPath()}${JOURNAL_SUFFIX}`, JSON.stringify({
      formatVersion: 1,
      migrationVersion: 43,
      state: 'copy',
    }));

    expect(() => initDb()).toThrow(/--resume/);
    expect(existsSync(dbPath())).toBe(false);
  });

  it('does not trust installed-pending-smoke when its installed DB is missing', () => {
    writeFileSync(`${dbPath()}${JOURNAL_SUFFIX}`, JSON.stringify({
      formatVersion: 1,
      migrationVersion: 43,
      state: 'installed-pending-smoke',
    }));

    expect(() => initDb()).toThrow(/--resume/);
    expect(existsSync(dbPath())).toBe(false);
  });

  it('rejects an oversized journal before reading or creating a database', () => {
    writeFileSync(`${dbPath()}${JOURNAL_SUFFIX}`, 'x'.repeat(64 * 1024 + 1));

    expect(() => initDb()).toThrow(/64 KiB.*--resume/i);
    expect(existsSync(dbPath())).toBe(false);
  });

  it('rejects invalid journal content with fixed recovery guidance', () => {
    writeFileSync(`${dbPath()}${JOURNAL_SUFFIX}`, '{invalid');

    expect(() => initDb()).toThrow(/state "invalid".*--resume/is);
    expect(existsSync(dbPath())).toBe(false);
  });

  it('rejects a symlinked journal as non-regular recovery metadata', () => {
    symlinkSync(
      join(paths.userData, 'missing-journal-target.json'),
      `${dbPath()}${JOURNAL_SUFFIX}`,
    );

    expect(() => initDb()).toThrow(/regular file.*--resume/i);
    expect(existsSync(dbPath())).toBe(false);
  });
});
