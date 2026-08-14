import { vi } from 'vitest';

export interface TestRow {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
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
  const pathAuthority = (raw: string): unknown => {
    try {
      const metadata = JSON.parse(raw) as Record<string, unknown>;
      return metadata.__agentDeckCanonicalPathAuthorityV1 ?? 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
  const state = {
    rows: [] as TestRow[],
    blobs: new Map<string, TestBlob>(),
    fileInsertArgs: [] as unknown[][],
    functions: new Map<string, (...args: unknown[]) => unknown>(),
  };
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn((...args: unknown[]) => {
      let rows = [...state.rows];
      if (sql.includes('FROM file_changes')) {
        const sessionId = args[0];
        rows = rows.filter((candidate) => candidate.session_id === sessionId);
      }
      if (sql.includes('(fc.ts < ? OR (fc.ts = ? AND fc.id < ?))')) {
        const [, cursorTs, , cursorId] = args as [string, number, number, number];
        rows = rows.filter(
          (candidate) =>
            candidate.ts < cursorTs ||
            (candidate.ts === cursorTs && candidate.id < cursorId),
        );
      }
      if (sql.includes('ORDER BY fc.ts DESC, fc.id DESC') && sql.includes('LIMIT ?')) {
        rows.sort((a, b) => b.ts - a.ts || b.id - a.id);
      } else if (sql.includes('ORDER BY fc.ts ASC, fc.id ASC')) {
        rows.sort((a, b) => a.ts - b.ts || a.id - b.id);
      }
      const limit = args.at(-1);
      const limited = typeof limit === 'number' ? rows.slice(0, limit) : rows;
      if (!sql.includes('AS has_before_blob')) return limited;
      const visible = state.functions.get('agent_deck_file_change_visible');
      return limited.map((candidate) => ({
        ...candidate,
        has_before_blob: candidate.before_blob !== null ? 1 : 0,
        has_after_blob: candidate.after_blob !== null ? 1 : 0,
        has_before_snapshot: candidate.before_snapshot_hash != null ? 1 : 0,
        has_after_snapshot: candidate.after_snapshot_hash != null ? 1 : 0,
        is_visible: visible?.(candidate.kind, candidate.metadata_json) ?? 1,
        path_authority: pathAuthority(candidate.metadata_json),
      }));
    }),
    get: vi.fn((...args: unknown[]) => {
      if (sql.includes('COUNT(*)')) return { c: state.rows.length };
      if (sql.includes('FROM file_snapshot_blobs')) {
        const digest = args[0];
        return Buffer.isBuffer(digest) ? state.blobs.get(digest.toString('hex')) : undefined;
      }
      if (sql.includes('FROM file_changes')) {
        const [sessionId, id] = args;
        const found = sql.includes('fc.file_path IN')
          ? state.rows
              .filter((candidate) =>
                candidate.session_id === sessionId &&
                (args.slice(1) as string[]).includes(candidate.file_path),
              )
              .sort((a, b) => b.ts - a.ts || b.id - a.id)[0]
          : state.rows.find(
              (candidate) => candidate.session_id === sessionId && candidate.id === id,
            );
        if (!found || sql.includes('fc.*')) return found;
        const projected: Record<string, unknown> = {
          id: found.id,
          session_id: found.session_id,
          file_path: found.file_path,
          kind: found.kind,
          metadata_json: found.metadata_json,
          tool_call_id: found.tool_call_id,
          ts: found.ts,
          path_authority: pathAuthority(found.metadata_json),
        };
        if (sql.includes('AS has_before_blob')) {
          Object.assign(projected, {
            has_before_blob: found.before_blob !== null ? 1 : 0,
            has_after_blob: found.after_blob !== null ? 1 : 0,
            has_before_snapshot: found.before_snapshot_hash != null ? 1 : 0,
            has_after_snapshot: found.after_snapshot_hash != null ? 1 : 0,
          });
        }
        if (sql.includes('fc.before_blob AS before_blob')) {
          Object.assign(projected, {
            before_blob: found.before_blob,
            before_snapshot_hash: found.before_snapshot_hash,
            before_snapshot_codec: found.before_snapshot_codec,
            before_snapshot_raw_bytes: found.before_snapshot_raw_bytes,
            before_snapshot_compressed_bytes: found.before_snapshot_compressed_bytes,
            before_snapshot_data: found.before_snapshot_data,
          });
        }
        if (sql.includes('fc.after_blob AS after_blob')) {
          Object.assign(projected, {
            after_blob: found.after_blob,
            after_snapshot_hash: found.after_snapshot_hash,
            after_snapshot_codec: found.after_snapshot_codec,
            after_snapshot_raw_bytes: found.after_snapshot_raw_bytes,
            after_snapshot_compressed_bytes: found.after_snapshot_compressed_bytes,
            after_snapshot_data: found.after_snapshot_data,
          });
        }
        return projected;
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
  const db = {
    prepare,
    transaction,
    function: vi.fn(
      (
        name: string,
        _options: unknown,
        callback: (...args: unknown[]) => unknown,
      ) => {
        state.functions.set(name, callback);
        return db;
      },
    ),
  };
  return { state, db };
});

vi.mock('../db', () => ({ getDb: () => dbMock.db }));

export function getFileChangeLoggerMock(): typeof loggerMock {
  return loggerMock;
}

export function getFileChangeDbMock(): typeof dbMock {
  return dbMock;
}
