import Database from 'better-sqlite3';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Journal {
  state: string;
  backupName: string;
  failedName: string | null;
}

const cliPath = resolve('scripts/history-search-offline.mjs');
const cliUrl = pathToFileURL(cliPath).href;
const runnerPath = resolve('scripts/run-history-search-migration.mjs');
let temporaryDirectory = '';
let databasePath = '';

function makeV42(): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    for (const migration of MIGRATIONS) {
      if (migration.version > 42) break;
      db.exec(migration.sql);
    }
    db.pragma('user_version = 42');
    db.prepare(
      `INSERT INTO sessions
        (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
       VALUES ('cli-test', 'codex-cli', '/repo', 'CLI test', 'sdk',
               'closed', 'idle', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
       VALUES ('cli-test', 'message', ?, 2, NULL)`,
    ).run(JSON.stringify({ text: 'CliEventFooBar' }));
    db.prepare(
      `INSERT INTO summaries(session_id, content, trigger, ts)
       VALUES ('cli-test', 'CliSummaryFooBar', 'manual', 3)`,
    ).run();
  } finally {
    db.close();
  }
}

function invoke(...args: string[]): CliResult {
  const cliArgs = ['--db', databasePath, ...args];
  const source = `
    const { runCli } = await import(${JSON.stringify(cliUrl)});
    try {
      await runCli(${JSON.stringify(cliArgs)}, { processRows: [] });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function expectSuccess(result: CliResult): void {
  expect(result.status, result.stderr).toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toContain(temporaryDirectory);
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      'durationMs',
      'mode',
      'outcome',
      'state',
      'version',
    ]);
  }
}

function readJournal(): Journal {
  return JSON.parse(
    readFileSync(`${databasePath}.migration-v43.json`, 'utf8'),
  ) as Journal;
}

function writeJournalState(state: string): Journal {
  const path = `${databasePath}.migration-v43.json`;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  journal.state = state;
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

function readVersion(path = databasePath): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

function applyRemainingStartupMigrations(): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    db.transaction(() => {
      for (const migration of MIGRATIONS) {
        if (migration.version <= 43) continue;
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
      }
    })();
  } finally {
    db.close();
  }
}

describe.skipIf(!bindingAvailable)('history-search offline CLI integration', () => {
  beforeEach(() => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'agent-deck-history-offline-'),
    );
    databasePath = join(temporaryDirectory, 'agent-deck.db');
    makeV42();
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('copy-migrates a V42 DB and rollback restores its verified backup', () => {
    expectSuccess(invoke());
    let journal = readJournal();
    expect(journal.state).toBe('installed-pending-smoke');
    expect(readVersion()).toBe(43);
    expect(existsSync(join(temporaryDirectory, journal.backupName))).toBe(true);

    expectSuccess(invoke('--rollback'));
    journal = readJournal();
    expect(journal.state).toBe('rolled-back');
    expect(readVersion()).toBe(42);
    expect(journal.failedName).not.toBeNull();
    expect(readVersion(join(temporaryDirectory, journal.failedName!))).toBe(43);
    expect(existsSync(join(temporaryDirectory, journal.backupName))).toBe(false);
  });

  it('finalizes after normal startup applies every remaining migration', () => {
    expectSuccess(invoke());
    const backupName = readJournal().backupName;
    applyRemainingStartupMigrations();
    expect(readVersion()).toBe(MIGRATIONS.at(-1)!.version);

    expectSuccess(invoke('--finalize', '--smoke-passed'));
    expect(readJournal().state).toBe('finalized');
    expect(readVersion()).toBe(MIGRATIONS.at(-1)!.version);
    expect(existsSync(join(temporaryDirectory, backupName))).toBe(false);
  });

  it.each([
    ['before-source-rename', 'ready'],
    ['after-source-rename-before-journal', 'ready'],
    ['after-source-backed-up-journal', 'source-backed-up'],
    ['after-candidate-rename-before-journal', 'source-backed-up'],
  ] as const)('resumes the %s crash window', (window, state) => {
    expectSuccess(invoke());
    const installed = readJournal();
    const backupPath = join(temporaryDirectory, installed.backupName);
    const candidatePath = join(
      temporaryDirectory,
      (installed as Journal & { candidateName: string }).candidateName,
    );

    if (window !== 'after-candidate-rename-before-journal') {
      renameSync(databasePath, candidatePath);
      renameSync(backupPath, databasePath);
    }
    if (
      window === 'after-source-rename-before-journal' ||
      window === 'after-source-backed-up-journal'
    ) {
      renameSync(databasePath, backupPath);
    }
    writeJournalState(state);

    expectSuccess(invoke('--resume'));
    expect(readJournal().state).toBe('installed-pending-smoke');
    expect(readVersion()).toBe(43);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);
  });

  it('refuses resume when the recorded V42 source fingerprint changed in place', () => {
    expectSuccess(invoke());
    const installed = readJournal() as Journal & { candidateName: string };
    const backupPath = join(temporaryDirectory, installed.backupName);
    const candidatePath = join(temporaryDirectory, installed.candidateName);
    renameSync(databasePath, candidatePath);
    renameSync(backupPath, databasePath);
    writeJournalState('ready');
    const changed = new Date(Date.now() + 10_000);
    utimesSync(databasePath, changed, changed);

    const result = invoke('--resume');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/journal lineage/i);
    expect(readVersion()).toBe(42);
    expect(readVersion(candidatePath)).toBe(43);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('fails a real lock preflight without creating a migration journal', () => {
    const locked = new Database(databasePath);
    let result: CliResult;
    try {
      locked.exec('BEGIN EXCLUSIVE');
      result = invoke();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Fully quit|lock check/i);
      expect(result.stderr).not.toContain(temporaryDirectory);
      expect(existsSync(`${databasePath}.migration-v43.json`)).toBe(false);
    } finally {
      locked.exec('ROLLBACK');
      locked.close();
    }
    expect(readVersion()).toBe(42);
  });

  it('keeps the stable runner actionable without logging the missing DB path', () => {
    const missing = join(temporaryDirectory, 'missing.db');
    const result = spawnSync(
      process.execPath,
      [runnerPath, '--db', missing],
      {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Database does not exist/);
    expect(result.stderr).toMatch(/rerun the same command/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(temporaryDirectory);
    expect(existsSync(`${missing}.migration-v43.json`)).toBe(false);
  });

  it('rejects an oversized recovery journal without reading or migrating it', () => {
    writeFileSync(
      `${databasePath}.migration-v43.json`,
      'x'.repeat(64 * 1024 + 1),
    );

    const result = invoke('--resume');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/64 KiB/i);
    expect(result.stderr).not.toContain(temporaryDirectory);
    expect(readVersion()).toBe(42);
  });

  it('rejects invalid recovery journal content with fixed operator guidance', () => {
    writeFileSync(`${databasePath}.migration-v43.json`, '{invalid');

    const result = invoke('--resume');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot be read.*restore it.*--resume/i);
    expect(result.stderr).not.toContain(temporaryDirectory);
    expect(readVersion()).toBe(42);
  });

  it('rejects a dangling journal symlink before starting a migration', () => {
    symlinkSync(
      join(temporaryDirectory, 'missing-journal-target.json'),
      `${databasePath}.migration-v43.json`,
    );

    const result = invoke();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/regular file.*--resume/i);
    expect(result.stderr).not.toContain(temporaryDirectory);
    expect(readVersion()).toBe(42);
  });
});
