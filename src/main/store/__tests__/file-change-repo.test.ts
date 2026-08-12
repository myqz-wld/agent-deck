import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  getFileChangeDbMock,
  getFileChangeLoggerMock,
  type TestRow,
} from './file-change-repo-test-fixture';
import { fileChangeRepo } from '../file-change-repo';
import { fileChangeReadRepo } from '../file-change-read-repo';
import { setFileChangeReadDiagnostics } from '../file-change-read-diagnostics-core';
import {
  encodeFileSnapshot,
  FILE_SNAPSHOT_CODEC,
  type EncodedFileSnapshot,
} from '../file-snapshot-codec';

const dbMock = getFileChangeDbMock();
const loggerMock = getFileChangeLoggerMock();

function row(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: 1,
    session_id: 's1',
    file_path: '/repo/a.ts',
    kind: 'text',
    before_blob: null,
    after_blob: null,
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
  const readDiagnosticsWarn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setFileChangeReadDiagnostics({ warn: readDiagnosticsWarn });
    dbMock.state.rows = [];
    dbMock.state.blobs.clear();
    dbMock.state.fileInsertArgs = [];
  });

  afterEach(() => {
    setFileChangeReadDiagnostics(null);
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
    expect(insertSql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
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

  it('returns null and warns once when a repeated blob is malformed', () => {
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
      row({ id: 2, ...malformed }),
      row({ id: 1, ...malformed }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.beforeSnapshot)).toEqual([null, null]);
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn.mock.calls[0][0]).toContain('snapshot blob decode failed');
  });

  it('warns and returns null when a hash points to a missing blob', () => {
    dbMock.state.rows = [row({ before_snapshot_hash: Buffer.alloc(32, 7) })];
    expect(fileChangeRepo.listForSession('s1')[0].beforeSnapshot).toBeNull();
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

  it('pages summaries with a stable same-timestamp id cursor and no snapshot joins', () => {
    dbMock.state.rows = [
      row({
        id: 3,
        ts: 100,
        file_path: '/repo/three.ts',
        before_blob: '',
        before_snapshot_hash: Buffer.alloc(32, 2),
        after_snapshot_hash: Buffer.alloc(32, 3),
      }),
      row({ id: 2, ts: 100, file_path: '/repo/two.ts' }),
      row({ id: 1, ts: 99, file_path: '/repo/one.ts' }),
    ];

    const first = fileChangeReadRepo.listSummaryPage('s1', { limit: 1 });
    const second = fileChangeReadRepo.listSummaryPage('s1', {
      limit: 1,
      cursor: first.nextCursor,
    });

    expect(first.items.map((item) => item.id)).toEqual([3]);
    expect(second.items.map((item) => item.id)).toEqual([2]);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(first.items[0]).not.toHaveProperty('metadata');
    expect(first.items[0]).not.toHaveProperty('beforeSnapshot');
    expect(first.items[0]).not.toHaveProperty('afterSnapshot');
    expect(first.items[0]).toMatchObject({
      hasBeforeBlob: true,
      hasAfterBlob: false,
      hasBeforeSnapshot: true,
      hasAfterSnapshot: true,
    });
    const summarySql = dbMock.db.prepare.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.includes('ORDER BY fc.ts DESC, fc.id DESC') && sql.includes('LIMIT ?'));
    const projection = summarySql?.slice(0, summarySql.indexOf('FROM')) ?? '';
    expect(summarySql).not.toContain('file_snapshot_blobs');
    expect(projection).toContain('fc.before_blob IS NOT NULL AS has_before_blob');
    expect(projection).toContain('fc.after_blob IS NOT NULL AS has_after_blob');
    expect(projection).toContain('fc.before_snapshot_hash IS NOT NULL');
    expect(projection).toContain('fc.after_snapshot_hash IS NOT NULL');
    expect(projection).toContain(
      'agent_deck_file_change_visible(fc.kind, fc.metadata_json) AS is_visible',
    );
    expect(projection).not.toMatch(/fc\.metadata_json\s+AS/);
    expect(projection).not.toContain('snapshot_codec');
    expect(projection).not.toContain('snapshot_data');
  });

  it('advances the raw cursor when a bounded page contains only historical no-ops', () => {
    dbMock.state.rows = Array.from({ length: 41 }, (_, index) =>
      row({
        id: 100 - index,
        ts: 100 - index,
        file_path: `/repo/noop-${index}.ts`,
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '',
        }),
      }),
    );

    const page = fileChangeReadRepo.listSummaryPage('s1', { limit: 10 });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('isolates malformed metadata and blobs in one session-bound payload lookup', () => {
    dbMock.state.rows = [
      row({
        id: 7,
        metadata_json: '{bad',
        before_snapshot_hash: Buffer.alloc(32, 7),
      }),
      row({ id: 8, session_id: 'other' }),
    ];

    const payload = fileChangeReadRepo.getPayload('s1', 7);
    expect(payload).toMatchObject({
      id: 7,
      metadata: {},
      beforeSnapshot: null,
    });
    expect(payload).not.toHaveProperty('hasBeforeBlob');
    expect(payload).not.toHaveProperty('hasAfterSnapshot');
    expect(fileChangeReadRepo.getPayload('s1', 8)).toBeNull();
    const payloadSql = dbMock.db.prepare.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.includes('WHERE fc.session_id = ?') && sql.includes('fc.id = ?'));
    expect(payloadSql?.match(/JOIN file_snapshot_blobs/g)).toHaveLength(2);
    expect(readDiagnosticsWarn.mock.calls.map(([, details]) => details)).toEqual(
      expect.arrayContaining([
        {
          action: 'decode',
          category: 'snapshot',
          source: 'file-change-storage',
          outcome: 'invalid',
        },
        {
          action: 'decode',
          category: 'metadata',
          source: 'file-change-storage',
          outcome: 'invalid',
        },
      ]),
    );
    expect(JSON.stringify(readDiagnosticsWarn.mock.calls)).not.toMatch(
      /s1|\{bad|070707|changeId|sessionId|digest|context|error/i,
    );
  });

  it('loads a session-bound descriptor without blobs, snapshots, or metadata', () => {
    dbMock.state.rows = [row({
      id: 7,
      before_blob: 'secret-before',
      after_blob: 'secret-after',
      before_snapshot_hash: Buffer.alloc(32, 1),
      after_snapshot_hash: Buffer.alloc(32, 2),
      metadata_json: JSON.stringify({ apiToken: 'must-not-load' }),
    })];

    expect(fileChangeReadRepo.getDescriptor('s1', 7)).toMatchObject({
      id: 7,
      sessionId: 's1',
      filePath: '/repo/a.ts',
      hasBeforeBlob: true,
      hasAfterBlob: true,
      hasBeforeSnapshot: true,
      hasAfterSnapshot: true,
    });
    expect(fileChangeReadRepo.getDescriptor('other', 7)).toBeNull();

    const sql = dbMock.db.prepare.mock.calls.at(-2)?.[0] as string;
    const projection = sql.slice(0, sql.indexOf('FROM'));
    expect(sql).not.toContain('file_snapshot_blobs');
    expect(projection).not.toContain('fc.*');
    expect(projection).toContain('AS path_authority');
    expect(projection).not.toMatch(/fc\.metadata_json\s+(?:AS|,)/u);
    expect(projection).not.toMatch(/fc\.before_blob\s+AS before_blob/u);
    expect(projection).not.toMatch(/fc\.after_blob\s+AS after_blob/u);
  });

  it('discovers boundaries without blobs and loads only the requested snapshot side', () => {
    const before = encodeFileSnapshot('old snapshot')!;
    const after = encodeFileSnapshot('new snapshot')!;
    const malformed = {
      snapshot_hash: Buffer.alloc(32, 9),
      snapshot_codec: FILE_SNAPSHOT_CODEC,
      snapshot_raw_bytes: 3,
      snapshot_compressed_bytes: 3,
      snapshot_data: Buffer.from('bad'),
    };
    dbMock.state.rows = [
      row({
        id: 1,
        ts: 1,
        before_blob: 'old',
        after_blob: 'large-opposite-after',
        ...selection('before', before),
        after_snapshot_hash: malformed.snapshot_hash,
        after_snapshot_codec: malformed.snapshot_codec,
        after_snapshot_raw_bytes: malformed.snapshot_raw_bytes,
        after_snapshot_compressed_bytes: malformed.snapshot_compressed_bytes,
        after_snapshot_data: malformed.snapshot_data,
      }),
      row({
        id: 2,
        ts: 2,
        before_blob: 'large-opposite-before',
        after_blob: 'new',
        before_snapshot_hash: malformed.snapshot_hash,
        before_snapshot_codec: malformed.snapshot_codec,
        before_snapshot_raw_bytes: malformed.snapshot_raw_bytes,
        before_snapshot_compressed_bytes: malformed.snapshot_compressed_bytes,
        before_snapshot_data: malformed.snapshot_data,
        ...selection('after', after),
      }),
    ];

    const boundaries = fileChangeReadRepo.readPathBoundaries('s1', ['/repo/a.ts']);

    expect(boundaries?.first).toMatchObject({
      id: 1,
      beforeBlob: 'old',
      afterBlob: null,
      beforeSnapshot: 'old snapshot',
      afterSnapshot: undefined,
    });
    expect(boundaries?.last).toMatchObject({
      id: 2,
      beforeBlob: null,
      afterBlob: 'new',
      beforeSnapshot: undefined,
      afterSnapshot: 'new snapshot',
    });
    expect(loggerMock.warn).not.toHaveBeenCalled();

    const sqlStatements = dbMock.db.prepare.mock.calls.map(([sql]) => sql as string);
    const scans = sqlStatements.filter(
      (sql) =>
        sql.includes('fc.file_path IN') &&
        (sql.includes('ORDER BY fc.ts ASC') || sql.includes('ORDER BY fc.ts DESC')),
    );
    expect(scans).toHaveLength(2);
    for (const sql of scans) {
      const projection = sql.slice(0, sql.indexOf('FROM'));
      expect(projection).not.toMatch(/before_blob|after_blob|snapshot/i);
      expect(projection).toContain('fc.id');
      expect(projection).toContain('fc.kind');
      expect(projection).toContain('fc.metadata_json');
      expect(projection).toContain('fc.ts');
    }

    const beforeSql = sqlStatements.find((sql) =>
      sql.includes('blob.codec AS before_snapshot_codec'),
    );
    const afterSql = sqlStatements.find((sql) =>
      sql.includes('blob.codec AS after_snapshot_codec'),
    );
    expect(beforeSql).not.toContain('fc.*');
    expect(beforeSql).toContain('fc.before_blob');
    expect(beforeSql).toContain('fc.before_snapshot_hash');
    expect(beforeSql).toContain('fc.metadata_json');
    expect(beforeSql).not.toMatch(/after_blob|after_snapshot/i);
    expect(afterSql).not.toContain('fc.*');
    expect(afterSql).toContain('fc.after_blob');
    expect(afterSql).toContain('fc.after_snapshot_hash');
    expect(afterSql).toContain('fc.metadata_json');
    expect(afterSql).not.toMatch(/before_blob|before_snapshot/i);
  });

  it('authorizes image paths with a guarded targeted query and no full-list snapshots', () => {
    fileChangeReadRepo.hasImagePathForSession('s1', '/repo/image.png');

    const sql = dbMock.db.prepare.mock.calls.at(-1)?.[0] as string;
    expect(sql).toContain('fc.file_path = ?');
    expect(sql).toContain('json_valid(fc.before_blob)');
    expect(sql).toContain("json_extract(fc.after_blob, '$.path')");
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('file_snapshot_blobs');
  });
});
