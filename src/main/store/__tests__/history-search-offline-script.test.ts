import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createJournal,
  JOURNAL_MAX_BYTES,
  JOURNAL_STATES,
  readJournal,
  sameFileIdentity,
  sameSourceIdentity,
  transitionJournal,
  writeJournal,
} from '../../../../scripts/history-search-offline/journal.mjs';
import {
  classifyLineageSnapshot,
  installReadyCandidate,
  rollbackToSource,
  runMigrationStateMachine,
} from '../../../../scripts/history-search-offline/swap.mjs';
import {
  assertDiskSpace,
} from '../../../../scripts/history-search-offline/validation.mjs';
import {
  parseArgs,
  safeErrorMessage,
} from '../../../../scripts/history-search-offline.mjs';

const sourceIdentity = {
  device: '1',
  inode: '10',
  size: '100',
  modifiedMs: '1',
};
const candidateIdentity = { device: '1', inode: '20' };

function journalFixture() {
  return createJournal({
    dbPath: '/data/agent-deck.db',
    sourceIdentity,
    sourceSize: 100,
    businessCounts: { sessions: 2 },
    candidateName: 'agent-deck.db.v43-test.tmp',
    backupName: 'agent-deck.db.test.bak',
    now: '2026-07-28T00:00:00.000Z',
  });
}

describe('history-search offline journal', () => {
  it('uses size and mtime for source authority while candidate lineage stays inode-stable', () => {
    const changed = { ...sourceIdentity, modifiedMs: '2' };
    expect(sameFileIdentity(sourceIdentity, changed)).toBe(true);
    expect(sameSourceIdentity(sourceIdentity, changed)).toBe(false);
  });

  it('declares every recovery state required by the V43 protocol', () => {
    expect(JOURNAL_STATES).toEqual(expect.arrayContaining([
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
    ]));
  });

  it('persists temp -> fsync(file) -> rename -> fsync(directory)', () => {
    const events: string[] = [];
    let nextFd = 10;
    writeJournal('/data/agent-deck.db', journalFixture(), {
      writeFileSync: (path: string) => events.push(`write:${path}`),
      openSync: (path: string) => {
        events.push(`open:${path}`);
        return nextFd++;
      },
      fsyncSync: (fd: number) => events.push(`fsync:${fd}`),
      closeSync: (fd: number) => events.push(`close:${fd}`),
      renameSync: (from: string, to: string) => events.push(`rename:${from}->${to}`),
    });

    expect(events).toEqual([
      'write:/data/agent-deck.db.migration-v43.json.tmp',
      'open:/data/agent-deck.db.migration-v43.json.tmp',
      'fsync:10',
      'close:10',
      'rename:/data/agent-deck.db.migration-v43.json.tmp->/data/agent-deck.db.migration-v43.json',
      'open:/data',
      'fsync:11',
      'close:11',
    ]);
  });

  it('does not fsync the directory when the atomic rename fails', () => {
    const events: string[] = [];
    let nextFd = 10;
    expect(() => writeJournal('/data/agent-deck.db', journalFixture(), {
      writeFileSync: (path: string) => events.push(`write:${path}`),
      openSync: (path: string) => {
        events.push(`open:${path}`);
        return nextFd++;
      },
      fsyncSync: (fd: number) => events.push(`fsync:${fd}`),
      closeSync: (fd: number) => events.push(`close:${fd}`),
      renameSync: () => {
        events.push('rename-failed');
        throw new Error('disk failure');
      },
    })).toThrow('disk failure');
    expect(events).not.toContain('open:/data');
  });

  it('records every named state and rejects unknown transitions', () => {
    const writes: Array<Record<string, unknown>> = [];
    const deps = {
      writeFileSync: (_path: string, text: string) => writes.push(JSON.parse(text)),
      openSync: vi.fn()
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(11),
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
      renameSync: vi.fn(),
    };
    const next = transitionJournal(
      '/data/agent-deck.db',
      journalFixture(),
      'copy',
      {},
      deps,
    );
    expect(next.state).toBe('copy');
    expect(writes.at(-1)?.state).toBe('copy');
    expect(() => transitionJournal(
      '/data/agent-deck.db',
      next,
      'invented',
      {},
      deps,
    )).toThrow(/unknown journal state/i);
  });

  it('rejects unsafe or non-integral business-count metadata', () => {
    expect(() => createJournal({
      dbPath: '/data/agent-deck.db',
      sourceIdentity,
      sourceSize: 100,
      businessCounts: { 'sessions"; DROP TABLE sessions; --': 2 },
      candidateName: 'agent-deck.db.v43-test.tmp',
      backupName: 'agent-deck.db.test.bak',
    })).toThrow(/business counts/i);
    expect(() => createJournal({
      dbPath: '/data/agent-deck.db',
      sourceIdentity,
      sourceSize: 100,
      businessCounts: { sessions: 1.5 },
      candidateName: 'agent-deck.db.v43-test.tmp',
      backupName: 'agent-deck.db.test.bak',
    })).toThrow(/business counts/i);
  });

  it('rejects oversized journals before attempting a synchronous read', () => {
    const readFile = vi.fn();
    expect(() => readJournal('/data/agent-deck.db', {
      lstatSync: () => ({
        isFile: () => true,
        size: JOURNAL_MAX_BYTES + 1,
      }),
      readFileSync: readFile,
    })).toThrow(/64 KiB/i);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects symlink or non-file journals before attempting a read', () => {
    const readFile = vi.fn();
    expect(() => readJournal('/data/agent-deck.db', {
      lstatSync: () => ({
        isFile: () => false,
        size: 100,
      }),
      readFileSync: readFile,
    })).toThrow(/regular file/i);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('history-search swap recovery', () => {
  const readyJournal = {
    ...journalFixture(),
    state: 'ready',
    candidateIdentity,
  };

  it.each([
    [
      'before source rename',
      { db: sourceIdentity, candidate: candidateIdentity, backup: null, failed: null },
      'ready',
    ],
    [
      'after source rename before journal update',
      { db: null, candidate: candidateIdentity, backup: sourceIdentity, failed: null },
      'source-backed-up',
    ],
    [
      'after source-backed-up journal update',
      { db: null, candidate: candidateIdentity, backup: sourceIdentity, failed: null },
      'source-backed-up',
    ],
    [
      'after candidate rename before journal update',
      { db: candidateIdentity, candidate: null, backup: sourceIdentity, failed: null },
      'installed',
    ],
  ] as const)('classifies %s without trusting filenames', (_label, snapshot, expected) => {
    expect(classifyLineageSnapshot(readyJournal, snapshot)).toBe(expected);
  });

  it('rejects an identity combination outside the recorded lineage', () => {
    expect(() => classifyLineageSnapshot(readyJournal, {
      db: { device: '9', inode: '9' },
      candidate: candidateIdentity,
      backup: sourceIdentity,
      failed: null,
    })).toThrow(/lineage/i);
  });

  it('treats an unrecorded partial candidate as restartable only while source stays put', () => {
    expect(classifyLineageSnapshot(journalFixture(), {
      db: sourceIdentity,
      candidate: { device: '1', inode: '99' },
      backup: null,
      failed: null,
    })).toBe('preparation');
  });

  it('recognizes backup deletion before the finalized journal update', () => {
    expect(classifyLineageSnapshot(readyJournal, {
      db: candidateIdentity,
      candidate: null,
      backup: null,
      failed: null,
    })).toBe('finalized-pending-journal');
  });

  it('journals each install rename boundary in recoverable order', () => {
    const events: string[] = [];
    installReadyCandidate({
      paths: {
        db: '/data/db',
        candidate: '/data/candidate',
        backup: '/data/backup',
      },
      clearSidecars: (path: string) => events.push(`clear:${path}`),
      renameSync: (from: string, to: string) => events.push(`rename:${from}->${to}`),
      fsyncDirectory: () => events.push('fsync-dir'),
      transition: (state: string) => events.push(`state:${state}`),
    });
    expect(events).toEqual([
      'clear:/data/db',
      'clear:/data/backup',
      'rename:/data/db->/data/backup',
      'fsync-dir',
      'state:source-backed-up',
      'rename:/data/candidate->/data/db',
      'fsync-dir',
      'state:installed-pending-smoke',
    ]);
  });

  it('preserves the failed new DB before restoring the validated source backup', () => {
    const events: string[] = [];
    rollbackToSource({
      paths: {
        db: '/data/db',
        backup: '/data/backup',
        failed: '/data/failed',
      },
      currentCandidatePath: '/data/db',
      clearSidecars: (path: string) => events.push(`clear:${path}`),
      renameSync: (from: string, to: string) => events.push(`rename:${from}->${to}`),
      fsyncDirectory: () => events.push('fsync-dir'),
      transition: (state: string) => events.push(`state:${state}`),
    });
    expect(events).toEqual([
      'state:recovery',
      'clear:/data/db',
      'clear:/data/backup',
      'clear:/data/failed',
      'rename:/data/db->/data/failed',
      'fsync-dir',
      'rename:/data/backup->/data/db',
      'fsync-dir',
      'state:rolled-back',
    ]);
  });
});

describe('history-search preparation failure injection', () => {
  it('rejects insufficient free space with an injected statfs snapshot', () => {
    expect(() => assertDiskSpace('/data/agent-deck.db', 100, {
      statfs: () => ({ bavail: 1n, bsize: 1n }),
    })).toThrow(/Insufficient disk space/);
  });

  it.each([
    ['lock', 'preflight'],
    ['disk', 'preflight'],
    ['copy', 'copy'],
    ['migration', 'migrate'],
    ['validation', 'validate'],
  ] as const)('records %s failure at deterministic state %s', async (kind, failedAt) => {
    const states: Array<Record<string, unknown>> = [];
    const operations: Record<string, ReturnType<typeof vi.fn>> = {
      preflight: vi.fn(),
      copy: vi.fn(),
      migrate: vi.fn(),
      validate: vi.fn(),
      install: vi.fn(),
    };
    operations[failedAt].mockRejectedValueOnce(new Error(`${kind} failure`));

    await expect(runMigrationStateMachine({
      transition: (state: string, patch: Record<string, unknown> = {}) =>
        states.push({ state, ...patch }),
      operations,
    })).rejects.toThrow(`${kind} failure`);
    expect(states.at(-1)).toMatchObject({ state: 'failed', failedAt });
    expect(operations.install).not.toHaveBeenCalled();
  });
});

describe('history-search CLI argument contract', () => {
  it('rejects conflicting or mode-inapplicable recovery flags', () => {
    expect(() => parseArgs([
      '--db',
      '/data/db',
      '--finalize',
      '--rollback',
    ])).toThrow(/mutually exclusive/);
    expect(() => parseArgs([
      '--db',
      '/data/db',
      '--smoke-passed',
    ])).toThrow(/only with --finalize/);
    expect(() => parseArgs([
      '--db',
      '/data/db',
      '--rollback',
      '--resume',
    ])).toThrow(/cannot be combined/);
    expect(() => parseArgs(['--db', '--resume'])).toThrow(/requires a path/);
  });

  it('redacts both lexical and canonical parents for symlinked input', () => {
    const root = mkdtempSync(join(tmpdir(), 'history-search-redaction-'));
    const canonicalParent = join(root, 'canonical');
    const aliasParent = join(root, 'alias');
    mkdirSync(canonicalParent);
    symlinkSync(canonicalParent, aliasParent, 'dir');
    const dbArgument = join(aliasParent, 'agent-deck.db');
    const resolvedParent = realpathSync(canonicalParent);
    const canonical = join(resolvedParent, 'agent-deck.db');
    try {
      const message = safeErrorMessage(
        new Error(`rename ${canonical} from ${resolvedParent} failed`),
        dbArgument,
      );

      expect(message).toContain('<database>');
      expect(message).not.toContain(aliasParent);
      expect(message).not.toContain(canonicalParent);
      expect(message).not.toContain(resolvedParent);
      expect(message).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
