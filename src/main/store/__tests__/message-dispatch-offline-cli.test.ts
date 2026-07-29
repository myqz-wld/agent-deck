import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INDEX_NAME,
  MessageDispatchMigrationError,
  TARGET_VERSION,
  failureDiagnostic,
  requiredFreeBytes,
  resolveDatabasePath,
  runMessageDispatchMigration,
} from '../../../../scripts/message-dispatch-offline.mjs';
import {
  assertAppStopped as assertProductionAppStopped,
} from '../../../../scripts/history-search-offline/validation.mjs';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const scriptPath = join(repoRoot, 'scripts/message-dispatch-offline.mjs');
const electronPath = createRequire(import.meta.url)('electron') as string;
let root = '';
let dbPath = '';

function createV55Database(messageRows = 64): void {
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    for (const migration of MIGRATIONS) {
      if (migration.version > 55) break;
      db.exec(migration.sql);
    }
    const insert = db.prepare(
      `INSERT INTO agent_deck_messages
         (id, team_id, from_session_id, to_session_id, body, status,
          status_reason, sent_at, delivered_at, attempt_count, last_attempt_at,
          delivering_since, reply_to_message_id, delivery_generation,
          delivery_lease_to_session_id)
       VALUES (?, NULL, 'source', ?, 'body', 'pending', NULL, ?, NULL, 0,
               NULL, NULL, NULL, 0, NULL)`,
    );
    db.transaction(() => {
      for (let index = 0; index < messageRows; index += 1) {
        insert.run(
          `message-${String(index).padStart(8, '0')}`,
          `target-${index % 257}`,
          1_700_000_000_000 + Math.floor(index / 4),
        );
      }
    })();
    db.pragma('user_version = 55');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

function readState(): {
  version: number;
  indexSql: string | null;
  quick: string;
  integrity: string;
  foreignKeys: unknown[];
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      version: Number(db.pragma('user_version', { simple: true })),
      indexSql: (db.prepare(
        `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`,
      ).pluck().get(INDEX_NAME) as string | undefined) ?? null,
      quick: String(db.pragma('quick_check', { simple: true })),
      integrity: String(db.pragma('integrity_check', { simple: true })),
      foreignKeys: db.pragma('foreign_key_check') as unknown[],
    };
  } finally {
    db.close();
  }
}

function run(overrides: Record<string, unknown> = {}) {
  return runMessageDispatchMigration({
    dbPath,
    assertStopped: () => {},
    availableBytes: () => requiredFreeBytes(1n) + 1n,
    ...overrides,
  });
}

function expectAtomicV55(): void {
  expect(readState()).toMatchObject({
    version: 55,
    indexSql: null,
    quick: 'ok',
    integrity: 'ok',
    foreignKeys: [],
  });
  expect(existsSync(`${dbPath}-journal`)).toBe(false);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
}

describe.skipIf(!bindingAvailable)('message dispatch offline V56 CLI', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-message-offline-'));
    dbPath = join(root, 'agent-deck.db');
    createV55Database();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects missing, symlinked, non-file, and non-owned targets', () => {
    const missing = join(root, 'missing.db');
    expect(() => resolveDatabasePath(missing)).toThrowError(
      expect.objectContaining({ code: 'database-missing' }),
    );
    const link = join(root, 'link.db');
    symlinkSync(dbPath, link);
    expect(() => resolveDatabasePath(link)).toThrowError(
      expect.objectContaining({ code: 'database-symlink' }),
    );
    expect(() => resolveDatabasePath(root)).toThrowError(
      expect.objectContaining({ code: 'database-not-regular' }),
    );
    expect(() => resolveDatabasePath(dbPath, {
      currentUid: () => (process.getuid?.() ?? 0) + 1,
    })).toThrowError(expect.objectContaining({ code: 'database-owner' }));
  });

  it('rejects a live/locked database before mutation', () => {
    expect(() => run({
      assertStopped: () => {
        throw new MessageDispatchMigrationError('database-active');
      },
    })).toThrowError(expect.objectContaining({ code: 'database-active' }));
    expectAtomicV55();

    const locker = new Database(dbPath);
    locker.exec('BEGIN EXCLUSIVE');
    try {
      expect(() => run({
        assertStopped: (
          Db: typeof Database,
          allPaths: string[],
          probes: string[],
        ) => assertProductionAppStopped(
          Db,
          allPaths,
          probes,
          { processRows: [] },
        ),
      })).toThrow(/Database files are open|Database lock check failed/);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    expectAtomicV55();
  });

  it('rejects insufficient disk and any version other than exact V55 or complete V56', () => {
    expect(() => run({ availableBytes: () => 0n })).toThrowError(
      expect.objectContaining({ code: 'insufficient-disk' }),
    );
    expectAtomicV55();

    const db = new Database(dbPath);
    db.pragma('user_version = 54');
    db.close();
    expect(() => run()).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    const verify = new Database(dbPath);
    verify.pragma('user_version = 56');
    verify.close();
    expect(() => run()).toThrowError(
      expect.objectContaining({ code: 'inconsistent-v56' }),
    );
  });

  it.each(['create-index', 'plan', 'quick-check', 'before-commit'] as const)(
    'rolls back deterministic %s failure to clean V55',
    (faultAt) => {
      expect(() => run({ faultAt })).toThrowError(
        expect.objectContaining({ code: `injected-${faultAt}` }),
      );
      expectAtomicV55();
    },
  );

  it('installs the exact index atomically and recognizes only a complete V56 rerun', () => {
    expect(run()).toMatchObject({
      outcome: 'migrated',
      fromVersion: 55,
      toVersion: TARGET_VERSION,
      indexName: INDEX_NAME,
    });
    const installed = readState();
    expect(installed).toMatchObject({
      version: 56,
      quick: 'ok',
      integrity: 'ok',
      foreignKeys: [],
    });
    expect(installed.indexSql).toMatch(
      /agent_deck_messages\(status, sent_at\)\s+WHERE status = 'pending'/,
    );
    expect(run()).toMatchObject({
      outcome: 'already-complete',
      fromVersion: 56,
      toVersion: 56,
    });
  });

  it('keeps committed V56 when reporting fails and recognizes it on rerun', () => {
    expect(() => run({
      report: () => {
        throw new Error('simulated report failure');
      },
    })).toThrow('simulated report failure');
    expect(readState()).toMatchObject({ version: 56 });
    expect(run()).toMatchObject({ outcome: 'already-complete' });
  });

  it('emits only fixed diagnostics for unknown errors', () => {
    const diagnostic = failureDiagnostic(
      new Error(`secret ${dbPath} https://private.invalid token=abc`),
    );
    expect(diagnostic).toEqual({
      event: 'message-dispatch-offline',
      outcome: 'failed',
      code: 'internal-failure',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(root);
    expect(JSON.stringify(diagnostic)).not.toContain('private.invalid');
    expect(JSON.stringify(diagnostic)).not.toContain('token=abc');
  });

  it('survives SIGKILL during a large CREATE INDEX as atomic V55 or complete V56', async () => {
    createV55Database(500_000);
    const helperPath = join(root, 'kill-helper.mjs');
    writeFileSync(
      helperPath,
      `import { runMessageDispatchMigration } from ${JSON.stringify(pathToFileURL(scriptPath).href)};
runMessageDispatchMigration({
  dbPath: process.argv[2],
  assertStopped() {},
  onPhase(phase) {
    if (phase === 'create-index') process.stdout.write('create-index\\n');
  },
});\n`,
      { mode: 0o600 },
    );

    const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveChild, rejectChild) => {
        const child = spawn(electronPath, [helperPath, dbPath], {
          cwd: repoRoot,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let createPhaseStarted = false;
        let killedDuringCreate = false;
        let journalProbe: ReturnType<typeof setInterval> | null = null;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (!createPhaseStarted && output.includes('create-index\n')) {
            createPhaseStarted = true;
            journalProbe = setInterval(() => {
              try {
                if (statSync(`${dbPath}-journal`).size > 512) {
                  killedDuringCreate = child.kill('SIGKILL');
                  if (journalProbe) clearInterval(journalProbe);
                  journalProbe = null;
                }
              } catch {
                // The rollback journal appears only after CREATE INDEX starts writing.
              }
            }, 1);
          }
        });
        child.on('error', rejectChild);
        child.on('close', (code, signal) => {
          if (journalProbe) clearInterval(journalProbe);
          if (!createPhaseStarted || !killedDuringCreate) {
            rejectChild(new Error('child exited before observable CREATE INDEX work'));
            return;
          }
          resolveChild({ code, signal });
        });
      },
    );
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.code).toBeNull();

    const recovered = new Database(dbPath);
    try {
      recovered.pragma('foreign_keys = ON');
      const version = Number(recovered.pragma('user_version', { simple: true }));
      const indexSql = recovered.prepare(
        `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`,
      ).pluck().get(INDEX_NAME) as string | undefined;
      expect([55, 56]).toContain(version);
      expect(Boolean(indexSql)).toBe(version === 56);
      expect(recovered.pragma('quick_check', { simple: true })).toBe('ok');
      expect(recovered.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(recovered.pragma('foreign_key_check')).toEqual([]);
      recovered.pragma('wal_checkpoint(TRUNCATE)');
      recovered.pragma('journal_mode = DELETE');
    } finally {
      recovered.close();
    }
    expect(run()).toMatchObject({
      toVersion: 56,
      indexName: INDEX_NAME,
    });
    expect(readState()).toMatchObject({
      version: 56,
      quick: 'ok',
      integrity: 'ok',
      foreignKeys: [],
    });
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  }, 45_000);
});
