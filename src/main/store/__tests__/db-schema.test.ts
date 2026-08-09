import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ userData: '' }));
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

import {
  UnsupportedDatabaseVersionError,
  closeDb,
  initDb,
} from '../db';
import { CURRENT_SCHEMA_VERSION } from '../schema';
import { bindingAvailable } from './_binding-probe';

const DB_NAME = 'agent-deck.db';

function dbPath(): string {
  return join(paths.userData, DB_NAME);
}

function initTestDb() {
  return initDb({ databasePath: dbPath(), diagnostics: loggerMock });
}

describe.skipIf(!bindingAvailable)('current database schema', () => {
  beforeEach(() => {
    for (const method of Object.values(loggerMock)) method.mockReset();
    paths.userData = mkdtempSync(join(tmpdir(), 'agent-deck-db-schema-'));
  });

  afterEach(() => {
    closeDb();
    rmSync(paths.userData, { recursive: true, force: true });
  });

  it('creates the complete current schema for a new database', () => {
    const db = initTestDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'event_search_fts_v1'`).get(),
    ).toBeDefined();
    expect(
      db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'context_window_observations'`).get(),
    ).toBeDefined();
  });

  it('initializes an existing empty database and reopens the current version', () => {
    new Database(dbPath()).close();
    expect(initTestDb().pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    closeDb();
    expect(initTestDb().pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps one authoritative host path until the database is closed', () => {
    const db = initTestDb();
    const secondPath = join(paths.userData, 'other.db');

    expect(() =>
      initDb({ databasePath: secondPath, diagnostics: loggerMock }),
    ).toThrow('already initialized for another host path');
    expect(db.open).toBe(true);
  });

  it('does not let a diagnostics failure change a successful database open', () => {
    const db = initDb({
      databasePath: dbPath(),
      diagnostics: {
        info: () => {
          throw new Error('diagnostics failed');
        },
        warn: () => {
          throw new Error('diagnostics failed');
        },
      },
    });

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rejects old and partial databases instead of mutating them', () => {
    const old = new Database(dbPath());
    old.exec('CREATE TABLE old_data (id INTEGER PRIMARY KEY, value TEXT)');
    old.prepare(`INSERT INTO old_data (id, value) VALUES (1, 'preserve-me')`).run();
    old.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
    old.close();
    const before = readFileSync(dbPath());

    expect(() => initTestDb()).toThrow(UnsupportedDatabaseVersionError);
    expect(readFileSync(dbPath())).toEqual(before);
    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION - 1);
    expect(verify.prepare(`SELECT name FROM sqlite_schema WHERE name = 'old_data'`).get()).toBeDefined();
    expect(verify.prepare(`SELECT value FROM old_data WHERE id = 1`).pluck().get()).toBe('preserve-me');
    verify.close();
  });

  it('rejects an incomplete database that claims the current version', () => {
    const partial = new Database(dbPath());
    partial.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    partial.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    partial.close();

    expect(() => initTestDb()).toThrow(
      new RegExp(`does not match the v${CURRENT_SCHEMA_VERSION} schema baseline`),
    );
    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(verify.prepare(`PRAGMA table_info(sessions)`).all()).toHaveLength(1);
    verify.close();
  });
});
