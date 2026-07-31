import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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
vi.mock('@main/utils/logger', () => ({
  default: { ...loggerMock, scope: () => loggerMock },
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
    const db = initDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'event_search_fts_v1'`).get(),
    ).toBeDefined();
  });

  it('initializes an existing empty database and reopens the current version', () => {
    new Database(dbPath()).close();
    expect(initDb().pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    closeDb();
    expect(initDb().pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rejects old and partial databases instead of mutating them', () => {
    const old = new Database(dbPath());
    old.exec('CREATE TABLE old_data (id INTEGER PRIMARY KEY)');
    old.pragma('user_version = 59');
    old.close();

    expect(() => initDb()).toThrow(UnsupportedDatabaseVersionError);
    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.pragma('user_version', { simple: true })).toBe(59);
    expect(verify.prepare(`SELECT name FROM sqlite_schema WHERE name = 'old_data'`).get()).toBeDefined();
    verify.close();
  });

  it('rejects an incomplete database that claims the current version', () => {
    const partial = new Database(dbPath());
    partial.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    partial.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    partial.close();

    expect(() => initDb()).toThrow(
      new RegExp(`does not match the v${CURRENT_SCHEMA_VERSION} schema baseline`),
    );
    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(verify.prepare(`PRAGMA table_info(sessions)`).all()).toHaveLength(1);
    verify.close();
  });
});
