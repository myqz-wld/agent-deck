/**
 * Issue tracker persistence.
 *
 * Appendices have an independent child-table lifecycle and cascade with their
 * parent. Source and resolution sessions remain nullable authorities. Resolving,
 * reopening, soft deletion, and hard deletion retain their existing boundaries.
 */
import type { Database } from 'better-sqlite3';
import { normalizeIssueBranchName } from '@shared/types';
import type {
  IssueAppendix,
  IssueRecord,
  IssueSeverity,
  IssueStatus,
  LogsRef,
} from '@shared/types';
import log from '@main/utils/logger';
import { getDb } from './db';
import { mergeIssueLogsRef } from './issue-repo-logs-ref';

const logger = log.scope('issue-repo');

interface IssueRow {
  id: string;
  title: string;
  description: string;
  repro: string | null;
  kind: string;
  status: string;
  severity: string;
  source_session_id: string | null;
  cwd: string | null;
  branch_name: string | null;
  logs_ref: string | null;
  resolution_session_id: string | null;
  labels: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  deleted_at: number | null;
}

interface AppendixRow {
  id: number;
  issue_id: string;
  body: string;
  logs_ref: string | null;
  appended_session_id: string | null;
  appended_at: number;
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; }
  catch {
    logger.warn('Issue data JSON decode failed', {
      action: 'issue-read',
      phase: 'decode',
      candidate: 1,
      changed: 0,
      duration: 0,
      outcome: 'invalid',
    });
    return fallback;
  }
}

function rowToRecord(r: IssueRow): IssueRecord {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    repro: r.repro,
    kind: r.kind,
    status: r.status as IssueStatus,
    severity: r.severity as IssueSeverity,
    sourceSessionId: r.source_session_id,
    cwd: r.cwd,
    branchName: r.branch_name,
    logsRef: safeJsonParse<LogsRef | null>(r.logs_ref, null),
    resolutionSessionId: r.resolution_session_id,
    labels: safeJsonParse<string[]>(r.labels, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    deletedAt: r.deleted_at,
  };
}

function appendixRowToRecord(r: AppendixRow): IssueAppendix {
  return {
    id: r.id,
    issueId: r.issue_id,
    body: r.body,
    logsRef: safeJsonParse<LogsRef | null>(r.logs_ref, null),
    appendedSessionId: r.appended_session_id,
    appendedAt: r.appended_at,
  };
}

export interface IssueCreateInput {
  title: string;
  description: string;
  repro?: string | null;
  kind?: string;
  severity?: IssueSeverity;
  sourceSessionId: string | null;
  cwd?: string | null;
  branchName?: string | null;
  logsRef?: LogsRef | null;
  labels?: string[];
}

export interface IssueUpdateInput {
  title?: string;
  description?: string;
  repro?: string | null;
  kind?: string;
  status?: IssueStatus;
  severity?: IssueSeverity;
  resolutionSessionId?: string | null;
  labels?: string[];
  logsRef?: LogsRef | null;
}

export interface IssueListOptions {
  statuses?: IssueStatus[];
  kinds?: string[];
  titleKeyword?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface IssueListForGcResult {
  resolvedExpired: string[];
  softDeletedExpired: string[];
}

export interface IssueAppendInput {
  issueId: string;
  body: string;
  logsRef?: LogsRef | null;
  appendedSessionId: string | null;
}

export interface IssueRepo {
  create(input: IssueCreateInput): IssueRecord;
  get(id: string): IssueRecord | null;
  /** Undefined fields are unchanged; explicit null clears nullable fields. */
  update(id: string, patch: IssueUpdateInput): IssueRecord | null;
  list(opts?: IssueListOptions): IssueRecord[];
  softDelete(id: string): boolean;
  undelete(id: string): boolean;
  hardDelete(id: string): boolean;
  listForGc(thresholds: {
    resolvedRetentionDays: number;
    softDeletedRetentionDays: number;
    nowMs?: number;
    limit?: number;
  }): IssueListForGcResult;
  /** Atomically append context and update the parent issue metadata. */
  appendContext(input: IssueAppendInput): IssueRecord | null;
  listAppendices(issueId: string): IssueAppendix[];
}

export function createIssueRepo(db: Database): IssueRepo {
  function get(id: string): IssueRecord | null {
    const row = db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as IssueRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  function getWithAppendices(id: string): IssueRecord | null {
    const rec = get(id);
    if (!rec) return null;
    rec.appendices = listAppendices(id);
    return rec;
  }

  function create(input: IssueCreateInput): IssueRecord {
    const title = (input.title ?? '').toString().trim();
    if (!title) throw new Error('title 不能为空');
    const description = (input.description ?? '').toString();
    if (!description.trim()) throw new Error('description 不能为空');
    const now = Date.now();
    const rec: IssueRecord = {
      id: crypto.randomUUID(),
      title,
      description,
      repro: input.repro ?? null,
      kind: input.kind ?? 'follow-up',
      status: 'open',
      severity: input.severity ?? 'medium',
      sourceSessionId: input.sourceSessionId ?? null,
      cwd: input.cwd ?? null,
      branchName: normalizeIssueBranchName(input.branchName),
      logsRef: input.logsRef ?? null,
      resolutionSessionId: null,
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      deletedAt: null,
    };
    db.prepare(
      `INSERT INTO issues
       (id, title, description, repro, kind, status, severity, source_session_id, cwd,
        branch_name, logs_ref, resolution_session_id, labels, created_at, updated_at,
        resolved_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      rec.id, rec.title, rec.description, rec.repro, rec.kind, rec.status, rec.severity,
      rec.sourceSessionId, rec.cwd, rec.branchName,
      JSON.stringify(rec.logsRef ?? null) === 'null' ? null : JSON.stringify(rec.logsRef),
      rec.resolutionSessionId, JSON.stringify(rec.labels), rec.createdAt, rec.updatedAt,
    );
    return rec;
  }

  function update(id: string, patch: IssueUpdateInput): IssueRecord | null {
    const existing = get(id);
    if (!existing) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    const cols: Record<string, string> = {
      title: 'title', description: 'description', repro: 'repro', kind: 'kind',
      status: 'status', severity: 'severity', resolutionSessionId: 'resolution_session_id',
      labels: 'labels', logsRef: 'logs_ref',
    };
    for (const key of Object.keys(cols) as (keyof IssueUpdateInput)[]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      if (key === 'title' && typeof value === 'string' && !value.trim()) {
        throw new Error('title 不能更新为空');
      }
      if (key === 'description' && typeof value === 'string' && !value.trim()) {
        throw new Error('description 不能更新为空');
      }
      sets.push(`${cols[key]} = ?`);
      if (key === 'labels') params.push(JSON.stringify(value ?? []));
      else if (key === 'logsRef') params.push(value == null ? null : JSON.stringify(value));
      else params.push(value ?? null);
    }
    const hasStatusPatch = Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== undefined;
    if (hasStatusPatch) {
      const oldS = existing.status;
      const newS = patch.status as IssueStatus;
      if (oldS !== 'resolved' && newS === 'resolved') {
        sets.push('resolved_at = ?'); params.push(Date.now());
      }
      // Leaving or reapplying resolved status preserves its previous timestamp.
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?'); params.push(Date.now());
    params.push(id);
    db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return get(id);
  }

  function list(opts: IssueListOptions = {}): IssueRecord[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.onlyDeleted) {
      conds.push('deleted_at IS NOT NULL');
    } else if (!opts.includeDeleted) {
      conds.push('deleted_at IS NULL');
    }
    if (opts.statuses && opts.statuses.length > 0) {
      conds.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      conds.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    }
    if (opts.titleKeyword && opts.titleKeyword.trim()) {
      conds.push(`LOWER(title) LIKE ?`);
      params.push(`%${opts.titleKeyword.trim().toLowerCase()}%`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = db.prepare(
      `SELECT * FROM issues ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as IssueRow[];
    return rows.map(rowToRecord);
  }

  function softDelete(id: string): boolean {
    const r = db.prepare(
      `UPDATE issues SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    ).run(Date.now(), Date.now(), id);
    return r.changes > 0;
  }

  function undelete(id: string): boolean {
    const r = db.prepare(
      `UPDATE issues SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    ).run(Date.now(), id);
    return r.changes > 0;
  }

  function hardDelete(id: string): boolean {
    const r = db.prepare(`DELETE FROM issues WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  function listForGc(opts: {
    resolvedRetentionDays: number; softDeletedRetentionDays: number; nowMs?: number; limit?: number;
  }): IssueListForGcResult {
    const now = opts.nowMs ?? Date.now();
    const limit = opts.limit ?? 500;
    const result: IssueListForGcResult = { resolvedExpired: [], softDeletedExpired: [] };
    if (opts.resolvedRetentionDays > 0) {
      const threshold = now - opts.resolvedRetentionDays * 86_400_000;
      const rows = db.prepare(
        `SELECT id FROM issues WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ? LIMIT ?`,
      ).all(threshold, limit) as { id: string }[];
      result.resolvedExpired = rows.map((r) => r.id);
    }
    if (opts.softDeletedRetentionDays > 0) {
      const threshold = now - opts.softDeletedRetentionDays * 86_400_000;
      const rows = db.prepare(
        `SELECT id FROM issues WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?`,
      ).all(threshold, limit) as { id: string }[];
      result.softDeletedExpired = rows.map((r) => r.id);
    }
    return result;
  }

  function appendContext(input: IssueAppendInput): IssueRecord | null {
    const now = Date.now();
    const appended = db.transaction((): boolean => {
      const row = db
        .prepare('SELECT * FROM issues WHERE id = ?')
        .get(input.issueId) as IssueRow | undefined;
      if (!row) return false;

      db.prepare(
        `INSERT INTO issue_appendices (issue_id, body, logs_ref, appended_session_id, appended_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.issueId,
        input.body,
        input.logsRef == null ? null : JSON.stringify(input.logsRef),
        input.appendedSessionId,
        now,
      );

      const logsRef = input.logsRef == null
        ? row.logs_ref
        : JSON.stringify(mergeIssueLogsRef(
            safeJsonParse<LogsRef | null>(row.logs_ref, null),
            input.logsRef,
            now,
          ));
      const updated = db
        .prepare('UPDATE issues SET logs_ref = ?, updated_at = ? WHERE id = ?')
        .run(logsRef, now, input.issueId);
      if (updated.changes !== 1) {
        throw new Error('Issue parent update did not affect exactly one row');
      }
      return true;
    })();
    if (!appended) return null;
    return getWithAppendices(input.issueId);
  }

  function listAppendices(issueId: string): IssueAppendix[] {
    const rows = db.prepare(
      `SELECT * FROM issue_appendices WHERE issue_id = ? ORDER BY appended_at ASC`,
    ).all(issueId) as AppendixRow[];
    return rows.map(appendixRowToRecord);
  }

  return {
    create, get, update, list,
    softDelete, undelete, hardDelete, listForGc,
    appendContext, listAppendices,
  };
}

let _defaultRepo: IssueRepo | null = null;
function defaultRepo(): IssueRepo {
  if (!_defaultRepo) _defaultRepo = createIssueRepo(getDb());
  return _defaultRepo;
}

export const issueRepo: IssueRepo = {
  create: (input) => defaultRepo().create(input),
  get: (id) => defaultRepo().get(id),
  update: (id, patch) => defaultRepo().update(id, patch),
  list: (opts) => defaultRepo().list(opts),
  softDelete: (id) => defaultRepo().softDelete(id),
  undelete: (id) => defaultRepo().undelete(id),
  hardDelete: (id) => defaultRepo().hardDelete(id),
  listForGc: (t) => defaultRepo().listForGc(t),
  appendContext: (input) => defaultRepo().appendContext(input),
  listAppendices: (issueId) => defaultRepo().listAppendices(issueId),
};
