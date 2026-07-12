import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestRow {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
  before_snapshot: string | null;
  after_snapshot: string | null;
  before_snapshot_hash?: Buffer | null;
  after_snapshot_hash?: Buffer | null;
  before_snapshot_codec?: unknown;
  before_snapshot_raw_bytes?: unknown;
  before_snapshot_compressed_bytes?: unknown;
  before_snapshot_data?: unknown;
  after_snapshot_codec?: unknown;
  after_snapshot_raw_bytes?: unknown;
  after_snapshot_compressed_bytes?: unknown;
  after_snapshot_data?: unknown;
  metadata_json: string;
  tool_call_id: string | null;
  ts: number;
}

interface TestBlob {
  codec: string;
  rawBytes: number;
  compressedBytes: number;
  data: Buffer;
}

const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => loggerMock } }));

const dbMock = vi.hoisted(() => {
  const state = {
    rows: [] as TestRow[],
    blobs: new Map<string, TestBlob>(),
    fileInsertArgs: [] as unknown[][],
  };
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn(() => state.rows),
    get: vi.fn((...args: unknown[]) => {
      if (sql.includes('COUNT(*)')) return { c: state.rows.length };
      if (sql.includes('FROM file_snapshot_blobs')) {
        const digest = args[0];
        return Buffer.isBuffer(digest) ? state.blobs.get(digest.toString('hex')) : undefined;
      }
      return undefined;
    }),
    run: vi.fn((...args: unknown[]) => {
      if (sql.includes('INSERT OR IGNORE INTO file_snapshot_blobs')) {
        const [digest, codec, rawBytes, compressedBytes, data] = args;
        const key = (digest as Buffer).toString('hex');
        if (state.blobs.has(key)) return { changes: 0, lastInsertRowid: 0 };
        state.blobs.set(key, {
          codec: codec as string,
          rawBytes: rawBytes as number,
          compressedBytes: compressedBytes as number,
          data: data as Buffer,
        });
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.includes('INSERT INTO file_changes')) {
        state.fileInsertArgs.push(args);
        return { changes: 1, lastInsertRowid: 41 };
      }
      return { changes: 1, lastInsertRowid: 1 };
    }),
  }));
  const transaction = vi.fn((callback: () => number) => () => callback());
  return { state, db: { prepare, transaction } };
});

vi.mock('../db', () => ({ getDb: () => dbMock.db }));

import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileChangeRepo } from '../file-change-repo';
import {
  encodeFileSnapshot,
  FILE_SNAPSHOT_CODEC,
  type EncodedFileSnapshot,
} from '../file-snapshot-codec';

function row(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: 1,
    session_id: 's1',
    file_path: '/repo/a.ts',
    kind: 'text',
    before_blob: null,
    after_blob: null,
    before_snapshot: null,
    after_snapshot: null,
    metadata_json: JSON.stringify({
      source: 'codex',
      changeKind: 'update',
      patchStatus: 'completed',
      diff: '@@ -1 +1 @@\n-old\n+new',
    }),
    tool_call_id: 'patch-1',
    ts: 1,
    ...overrides,
  };
}

function selection(side: 'before' | 'after', snapshot: EncodedFileSnapshot) {
  return {
    [`${side}_snapshot_hash`]: snapshot.digest,
    [`${side}_snapshot_codec`]: FILE_SNAPSHOT_CODEC,
    [`${side}_snapshot_raw_bytes`]: snapshot.rawBytes,
    [`${side}_snapshot_compressed_bytes`]: snapshot.compressedBytes,
    [`${side}_snapshot_data`]: snapshot.data,
  };
}

function record(beforeSnapshot: string | null, afterSnapshot: string | null) {
  return {
    sessionId: 's1',
    filePath: '/repo/a.ts',
    kind: 'text',
    beforeBlob: null,
    afterBlob: null,
    beforeSnapshot,
    afterSnapshot,
    metadata: { source: 'Edit' },
    toolCallId: 'tool-1',
    ts: 123,
  };
}

describe('fileChangeRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.rows = [];
    dbMock.state.blobs.clear();
    dbMock.state.fileInsertArgs = [];
  });

  it('atomically deduplicates snapshots and stores only hash references on new rows', () => {
    expect(fileChangeRepo.insert(record('same snapshot', 'same snapshot'))).toBe(41);

    expect(dbMock.db.transaction).toHaveBeenCalledOnce();
    expect(dbMock.state.blobs.size).toBe(1);
    expect(dbMock.state.fileInsertArgs).toHaveLength(1);
    const args = dbMock.state.fileInsertArgs[0];
    expect(args).toHaveLength(10);
    expect(args[5]).toEqual(args[6]);
    expect(Buffer.isBuffer(args[5])).toBe(true);
    expect(args[7]).toBe(JSON.stringify({ source: 'Edit' }));

    const insertSql = dbMock.db.prepare.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.includes('INSERT INTO file_changes'));
    expect(insertSql).toContain('VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)');
  });

  it('accepts a verified digest conflict and rejects corrupted conflicting bytes', () => {
    const encoded = encodeFileSnapshot('existing')!;
    dbMock.state.blobs.set(encoded.digestHex, {
      codec: FILE_SNAPSHOT_CODEC,
      rawBytes: encoded.rawBytes,
      compressedBytes: encoded.compressedBytes,
      data: encoded.data,
    });
    expect(fileChangeRepo.insert(record('existing', null))).toBe(41);

    dbMock.state.fileInsertArgs = [];
    const corrupt = Buffer.from(deflateRawSync(Buffer.from('corrupt'), { level: 1 }));
    dbMock.state.blobs.set(encoded.digestHex, {
      codec: FILE_SNAPSHOT_CODEC,
      rawBytes: Buffer.byteLength('corrupt'),
      compressedBytes: corrupt.length,
      data: corrupt,
    });
    expect(() => fileChangeRepo.insert(record('existing', null))).toThrow(
      /failed digest verification/,
    );
    expect(dbMock.state.fileInsertArgs).toHaveLength(0);
  });

  it('decodes joined blobs and reuses one decoded value for repeated digests', () => {
    const encoded = encodeFileSnapshot('shared snapshot 🦄')!;
    dbMock.state.rows = [
      row({ id: 2, ...selection('before', encoded) }),
      row({ id: 1, ...selection('after', encoded) }),
    ];

    const records = fileChangeRepo.listForSession('s1');
    expect(records[0].beforeSnapshot).toBe('shared snapshot 🦄');
    expect(records[1].afterSnapshot).toBe('shared snapshot 🦄');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('falls back to legacy text and warns once when a repeated blob is malformed', () => {
    const raw = Buffer.from('expected');
    const digest = createHash('sha256').update(raw).digest();
    const corrupt = deflateRawSync(Buffer.from('different'), { level: 1 });
    const malformed = {
      before_snapshot_hash: digest,
      before_snapshot_codec: FILE_SNAPSHOT_CODEC,
      before_snapshot_raw_bytes: Buffer.byteLength('different'),
      before_snapshot_compressed_bytes: corrupt.length,
      before_snapshot_data: corrupt,
    };
    dbMock.state.rows = [
      row({ id: 2, before_snapshot: 'legacy-2', ...malformed }),
      row({ id: 1, before_snapshot: 'legacy-1', ...malformed }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.beforeSnapshot)).toEqual([
      'legacy-2',
      'legacy-1',
    ]);
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn.mock.calls[0][0]).toContain('snapshot blob decode failed');
  });

  it('silently reads legacy snapshot rows that have not been backfilled', () => {
    dbMock.state.rows = [row({ before_snapshot: 'legacy', before_snapshot_hash: null })];
    expect(fileChangeRepo.listForSession('s1')[0].beforeSnapshot).toBe('legacy');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('warns and falls back when a hash points to a missing blob', () => {
    dbMock.state.rows = [
      row({ before_snapshot: 'legacy', before_snapshot_hash: Buffer.alloc(32, 7) }),
    ];
    expect(fileChangeRepo.listForSession('s1')[0].beforeSnapshot).toBe('legacy');
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn.mock.calls[0][0]).toContain('snapshot blob decode failed');
  });

  it('filters historical Codex no-op file changes while preserving real changes', () => {
    dbMock.state.rows = [
      row({
        id: 1,
        file_path: '/repo/noop-empty.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '',
        }),
      }),
      row({
        id: 2,
        file_path: '/repo/noop-same.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '@@ -1 +1 @@\n-same\n+same',
        }),
      }),
      row({
        id: 3,
        file_path: '/repo/failed.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'failed',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }),
      }),
      row({ id: 4, file_path: '/repo/real.ts' }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.filePath)).toEqual([
      '/repo/real.ts',
    ]);
  });

  it('does not apply Codex no-op filtering to non-Codex or non-text records', () => {
    dbMock.state.rows = [
      row({
        id: 1,
        file_path: '/repo/claude-empty.ts',
        metadata_json: JSON.stringify({ source: 'Edit', diff: '' }),
      }),
      row({
        id: 2,
        file_path: '/repo/image.png',
        kind: 'image',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '',
        }),
      }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.filePath)).toEqual([
      '/repo/claude-empty.ts',
      '/repo/image.png',
    ]);
  });
});
