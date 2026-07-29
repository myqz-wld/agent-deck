import type {
  FileChangePage,
  FileChangePayload,
  FileChangeSummary,
} from '@shared/types';
import {
  isEffectiveCodexFileChange,
  isIncompleteCodexFileChangeStatus,
} from '@shared/codex-file-change';
import log from '@main/utils/logger';
import { getDb } from './db';
import { FileSnapshotReader } from './file-snapshot-reader';

const logger = log.scope('store-file-change-read-repo');
const MIN_RAW_PAGE_SCAN = 40;
const MAX_RAW_PAGE_SCAN = 400;
const PATH_SCAN_BATCH = 100;
const visibilityFunctionDatabases = new WeakSet<object>();

interface BaseRow {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
  before_snapshot?: string | null;
  after_snapshot?: string | null;
  before_snapshot_hash?: Buffer | null;
  after_snapshot_hash?: Buffer | null;
  metadata_json: string;
  tool_call_id: string | null;
  has_before_blob?: number;
  has_after_blob?: number;
  has_before_snapshot?: number;
  has_after_snapshot?: number;
  is_visible?: number;
  ts: number;
}

interface PayloadRow extends BaseRow {
  before_snapshot_codec?: unknown;
  before_snapshot_raw_bytes?: unknown;
  before_snapshot_compressed_bytes?: unknown;
  before_snapshot_data?: unknown;
  after_snapshot_codec?: unknown;
  after_snapshot_raw_bytes?: unknown;
  after_snapshot_compressed_bytes?: unknown;
  after_snapshot_data?: unknown;
}

interface Cursor {
  ts: number;
  id: number;
}

type BoundaryRow = Pick<BaseRow, 'id' | 'kind' | 'metadata_json' | 'ts'>;

export interface FileChangePatchPage {
  items: Array<{ id: number; ts: number; diff: string | null }>;
  nextCursor: string | null;
}

function reportInvalidStoredValue(category: 'metadata' | 'snapshot'): void {
  logger.warn({
    action: 'decode',
    category,
    source: 'file-change-storage',
    outcome: 'invalid',
  });
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  try {
    if (typeof raw !== 'string') throw new Error();
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    reportInvalidStoredValue('metadata');
    return {};
  }
}

function readCodexChangeKind(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

export function shouldExposeFileChange(
  kind: string,
  metadata: Record<string, unknown>,
): boolean {
  if (kind !== 'text' || metadata.source !== 'codex') return true;
  if (isIncompleteCodexFileChangeStatus(metadata.patchStatus)) return false;
  const diff = typeof metadata.diff === 'string' ? metadata.diff : undefined;
  return isEffectiveCodexFileChange(readCodexChangeKind(metadata.changeKind), diff);
}

function ensureVisibilityFunction(db: ReturnType<typeof getDb>): void {
  if (visibilityFunctionDatabases.has(db)) return;
  db.function(
    'agent_deck_file_change_visible',
    { deterministic: true },
    (kind: unknown, rawMetadata: unknown) =>
      shouldExposeFileChange(
        typeof kind === 'string' ? kind : '',
        parseMetadata(rawMetadata),
      )
        ? 1
        : 0,
  );
  visibilityFunctionDatabases.add(db);
}

function toSummary(row: BaseRow): FileChangeSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    kind: row.kind,
    toolCallId: row.tool_call_id,
    hasBeforeBlob: Boolean(row.has_before_blob),
    hasAfterBlob: Boolean(row.has_after_blob),
    hasBeforeSnapshot: Boolean(row.has_before_snapshot),
    hasAfterSnapshot: Boolean(row.has_after_snapshot),
    ts: row.ts,
  };
}

function snapshotSelection(row: PayloadRow, side: 'before' | 'after') {
  return {
    hash: row[`${side}_snapshot_hash`],
    codec: row[`${side}_snapshot_codec`],
    rawBytes: row[`${side}_snapshot_raw_bytes`],
    compressedBytes: row[`${side}_snapshot_compressed_bytes`],
    data: row[`${side}_snapshot_data`],
  };
}

function snapshotReader(): FileSnapshotReader {
  return new FileSnapshotReader(() => {
    reportInvalidStoredValue('snapshot');
  });
}

function toPayload(row: PayloadRow, sides: ReadonlySet<'before' | 'after'>): FileChangePayload {
  const snapshots = snapshotReader();
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    kind: row.kind,
    beforeBlob: row.before_blob ?? null,
    afterBlob: row.after_blob ?? null,
    beforeSnapshot: sides.has('before')
      ? snapshots.read(
          snapshotSelection(row, 'before'),
          row.before_snapshot,
          'file-change-payload',
        )
      : undefined,
    afterSnapshot: sides.has('after')
      ? snapshots.read(
          snapshotSelection(row, 'after'),
          row.after_snapshot,
          'file-change-payload',
        )
      : undefined,
    metadata: parseMetadata(row.metadata_json),
    toolCallId: row.tool_call_id,
    ts: row.ts,
  };
}

function encodeCursor(row: Pick<BaseRow, 'ts' | 'id'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ts: row.ts, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      v?: unknown;
      ts?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.ts) ||
      !Number.isSafeInteger(parsed.id) ||
      Number(parsed.id) < 1
    ) {
      throw new Error();
    }
    return { ts: Number(parsed.ts), id: Number(parsed.id) };
  } catch {
    throw new Error('无效的文件改动分页游标。');
  }
}

function pathPredicate(candidates: string[]): { sql: string; args: string[] } {
  const unique = [...new Set(candidates.filter(Boolean))].slice(0, 8);
  if (unique.length === 0) return { sql: '0', args: [] };
  return { sql: `fc.file_path IN (${unique.map(() => '?').join(', ')})`, args: unique };
}

function findBoundary(
  sessionId: string,
  candidates: string[],
  direction: 'ASC' | 'DESC',
): BoundaryRow | null {
  const paths = pathPredicate(candidates);
  let cursor: Cursor | null = null;
  for (;;) {
    const comparison = direction === 'ASC' ? '>' : '<';
    const cursorSql = cursor
      ? `AND (fc.ts ${comparison} ? OR (fc.ts = ? AND fc.id ${comparison} ?))`
      : '';
    const args: unknown[] = [sessionId, ...paths.args];
    if (cursor) args.push(cursor.ts, cursor.ts, cursor.id);
    args.push(PATH_SCAN_BATCH);
    const rows = getDb()
      .prepare(
        `SELECT fc.id, fc.kind, fc.metadata_json, fc.ts
           FROM file_changes AS fc
          WHERE fc.session_id = ? AND ${paths.sql}
                ${cursorSql}
       ORDER BY fc.ts ${direction}, fc.id ${direction}
          LIMIT ?`,
      )
      .all(...args) as BoundaryRow[];
    for (const row of rows) {
      if (shouldExposeFileChange(row.kind, parseMetadata(row.metadata_json))) return row;
    }
    if (rows.length < PATH_SCAN_BATCH) return null;
    cursor = rows.at(-1) ?? null;
  }
}

function getBoundaryPayload(
  sessionId: string,
  id: number,
  side: 'before' | 'after',
): FileChangePayload | null {
  const row = getDb()
    .prepare(
      `SELECT fc.id, fc.session_id, fc.file_path, fc.kind,
              fc.${side}_blob AS ${side}_blob,
              fc.${side}_snapshot AS ${side}_snapshot,
              fc.${side}_snapshot_hash AS ${side}_snapshot_hash,
              fc.metadata_json, fc.tool_call_id, fc.ts,
              blob.codec AS ${side}_snapshot_codec,
              blob.raw_bytes AS ${side}_snapshot_raw_bytes,
              blob.compressed_bytes AS ${side}_snapshot_compressed_bytes,
              blob.data AS ${side}_snapshot_data
         FROM file_changes AS fc
    LEFT JOIN file_snapshot_blobs AS blob
           ON blob.digest = fc.${side}_snapshot_hash
        WHERE fc.session_id = ? AND fc.id = ?
        LIMIT 1`,
    )
    .get(sessionId, id) as PayloadRow | undefined;
  return row ? toPayload(row, new Set([side])) : null;
}

export const fileChangeReadRepo = {
  listSummaryPage(
    sessionId: string,
    options: { cursor?: string | null; limit: number },
  ): FileChangePage {
    const cursor = decodeCursor(options.cursor);
    const db = getDb();
    ensureVisibilityFunction(db);
    const scanLimit = Math.min(
      MAX_RAW_PAGE_SCAN,
      Math.max(MIN_RAW_PAGE_SCAN, options.limit * 4),
    );
    const cursorSql = cursor
      ? 'AND (fc.ts < ? OR (fc.ts = ? AND fc.id < ?))'
      : '';
    const args: unknown[] = [sessionId];
    if (cursor) args.push(cursor.ts, cursor.ts, cursor.id);
    args.push(scanLimit + 1);
    const rows = db
      .prepare(
        `SELECT fc.id, fc.session_id, fc.file_path, fc.kind, fc.tool_call_id,
                fc.before_blob IS NOT NULL AS has_before_blob,
                fc.after_blob IS NOT NULL AS has_after_blob,
                (fc.before_snapshot_hash IS NOT NULL OR fc.before_snapshot IS NOT NULL)
                  AS has_before_snapshot,
                (fc.after_snapshot_hash IS NOT NULL OR fc.after_snapshot IS NOT NULL)
                  AS has_after_snapshot,
                agent_deck_file_change_visible(fc.kind, fc.metadata_json) AS is_visible,
                fc.ts
           FROM file_changes AS fc
          WHERE fc.session_id = ?
                ${cursorSql}
       ORDER BY fc.ts DESC, fc.id DESC
          LIMIT ?`,
      )
      .all(...args) as BaseRow[];

    const items: FileChangeSummary[] = [];
    let scanned = 0;
    for (const row of rows.slice(0, scanLimit)) {
      scanned += 1;
      if (row.is_visible) items.push(toSummary(row));
      if (items.length === options.limit) break;
    }
    const lastScanned = scanned > 0 ? rows[scanned - 1] : null;
    const hasMore = Boolean(lastScanned && (scanned < rows.length || rows.length > scanLimit));
    return { items, nextCursor: hasMore && lastScanned ? encodeCursor(lastScanned) : null };
  },

  getPayload(sessionId: string, id: number): FileChangePayload | null {
    const row = getDb()
      .prepare(
        `SELECT fc.*,
                before_blob_row.codec AS before_snapshot_codec,
                before_blob_row.raw_bytes AS before_snapshot_raw_bytes,
                before_blob_row.compressed_bytes AS before_snapshot_compressed_bytes,
                before_blob_row.data AS before_snapshot_data,
                after_blob_row.codec AS after_snapshot_codec,
                after_blob_row.raw_bytes AS after_snapshot_raw_bytes,
                after_blob_row.compressed_bytes AS after_snapshot_compressed_bytes,
                after_blob_row.data AS after_snapshot_data
           FROM file_changes AS fc
      LEFT JOIN file_snapshot_blobs AS before_blob_row
             ON before_blob_row.digest = fc.before_snapshot_hash
      LEFT JOIN file_snapshot_blobs AS after_blob_row
             ON after_blob_row.digest = fc.after_snapshot_hash
          WHERE fc.session_id = ? AND fc.id = ?
          LIMIT 1`,
      )
      .get(sessionId, id) as PayloadRow | undefined;
    return row ? toPayload(row, new Set(['before', 'after'])) : null;
  },

  readPathBoundaries(
    sessionId: string,
    candidates: string[],
  ): { first: FileChangePayload; last: FileChangePayload } | null {
    const firstRow = findBoundary(sessionId, candidates, 'ASC');
    const lastRow = findBoundary(sessionId, candidates, 'DESC');
    if (!firstRow || !lastRow) return null;
    const first = getBoundaryPayload(sessionId, firstRow.id, 'before');
    const last = getBoundaryPayload(sessionId, lastRow.id, 'after');
    return first && last ? { first, last } : null;
  },

  listPathPatchPage(
    sessionId: string,
    candidates: string[],
    cursorValue?: string | null,
  ): FileChangePatchPage {
    const paths = pathPredicate(candidates);
    const cursor = decodeCursor(cursorValue);
    const cursorSql = cursor
      ? 'AND (fc.ts < ? OR (fc.ts = ? AND fc.id < ?))'
      : '';
    const args: unknown[] = [sessionId, ...paths.args];
    if (cursor) args.push(cursor.ts, cursor.ts, cursor.id);
    args.push(PATH_SCAN_BATCH + 1);
    const rows = getDb()
      .prepare(
        `SELECT fc.id, fc.session_id, fc.file_path, fc.kind, fc.metadata_json,
                fc.tool_call_id, fc.ts
           FROM file_changes AS fc
          WHERE fc.session_id = ? AND ${paths.sql} ${cursorSql}
       ORDER BY fc.ts DESC, fc.id DESC
          LIMIT ?`,
      )
      .all(...args) as BaseRow[];
    const scanned = rows.slice(0, PATH_SCAN_BATCH);
    const items = scanned
      .map((row) => ({ row, metadata: parseMetadata(row.metadata_json) }))
      .filter(({ row, metadata }) => shouldExposeFileChange(row.kind, metadata))
      .map(({ row, metadata }) => ({
        id: row.id,
        ts: row.ts,
        diff: typeof metadata.diff === 'string' ? metadata.diff : null,
      }));
    const last = scanned.at(-1);
    return {
      items,
      nextCursor: rows.length > PATH_SCAN_BATCH && last ? encodeCursor(last) : null,
    };
  },

  hasImagePathForSession(sessionId: string, filePath: string): boolean {
    if (!sessionId || !filePath) return false;
    const row = getDb()
      .prepare(
        `SELECT 1
           FROM file_changes AS fc
          WHERE fc.session_id = ?
            AND (
              fc.file_path = ?
              OR (fc.kind = 'image' AND
                  CASE WHEN json_valid(fc.before_blob)
                    THEN json_extract(fc.before_blob, '$.kind') = 'path'
                     AND json_extract(fc.before_blob, '$.path') = ?
                    ELSE 0 END)
              OR (fc.kind = 'image' AND
                  CASE WHEN json_valid(fc.after_blob)
                    THEN json_extract(fc.after_blob, '$.kind') = 'path'
                     AND json_extract(fc.after_blob, '$.path') = ?
                    ELSE 0 END)
            )
          LIMIT 1`,
      )
      .get(sessionId, filePath, filePath, filePath);
    return row !== undefined;
  },
};
