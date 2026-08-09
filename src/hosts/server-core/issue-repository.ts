import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { IssueUpdatePatchDto } from '@contracts/index';
import type {
  IssueAppendix,
  IssueRecord,
  IssueSeverity,
  IssueStatus,
  LogsRef,
} from '@shared/types';
import { mergeIssueLogsRef } from '@main/store/issue-repo-logs-ref';

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

export interface ServerCoreIssueRepositoryDiagnostics {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface ServerCoreIssueListOptions {
  statuses?: IssueStatus[];
  kinds?: string[];
  titleKeyword?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface ServerCoreIssueCreateInput {
  readonly title: string;
  readonly description: string;
  readonly repro?: string | null;
  readonly kind?: string;
  readonly severity?: IssueSeverity;
  readonly sourceSessionId: string;
  readonly cwd?: string | null;
  readonly branchName?: string | null;
  readonly logsRef?: LogsRef | null;
  readonly labels?: string[];
}

export interface ServerCoreIssueAppendInput {
  readonly issueId: string;
  readonly body: string;
  readonly logsRef?: LogsRef | null;
  readonly appendedSessionId: string;
}

function safeWarn(
  diagnostics: ServerCoreIssueRepositoryDiagnostics,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  try { diagnostics.warn(message, details); } catch {}
}

function json<T>(
  value: string | null,
  fallback: T,
  field: string,
  diagnostics: ServerCoreIssueRepositoryDiagnostics,
): T {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch {
    safeWarn(diagnostics, 'issue JSON field is invalid', {
      action: 'issue-read', field, outcome: 'invalid', source: 'issue-storage',
    });
    return fallback;
  }
}

function record(row: IssueRow, diagnostics: ServerCoreIssueRepositoryDiagnostics): IssueRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    repro: row.repro,
    kind: row.kind,
    status: row.status as IssueStatus,
    severity: row.severity as IssueSeverity,
    sourceSessionId: row.source_session_id,
    cwd: row.cwd,
    branchName: row.branch_name,
    logsRef: json<LogsRef | null>(row.logs_ref, null, 'logsRef', diagnostics),
    resolutionSessionId: row.resolution_session_id,
    labels: json<string[]>(row.labels, [], 'labels', diagnostics),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    deletedAt: row.deleted_at,
  };
}

function appendix(
  row: AppendixRow,
  diagnostics: ServerCoreIssueRepositoryDiagnostics,
): IssueAppendix {
  return {
    id: row.id,
    issueId: row.issue_id,
    body: row.body,
    logsRef: json<LogsRef | null>(row.logs_ref, null, 'appendix.logsRef', diagnostics),
    appendedSessionId: row.appended_session_id,
    appendedAt: row.appended_at,
  };
}

/** Electron-free mutable Issue projection over the authoritative Core database. */
export class ServerCoreIssueRepository {
  constructor(
    private readonly database: () => Database,
    private readonly diagnostics: ServerCoreIssueRepositoryDiagnostics,
  ) {}

  get(id: string): IssueRecord | null {
    const row = this.database().prepare('SELECT * FROM issues WHERE id = ?')
      .get(id) as IssueRow | undefined;
    return row ? record(row, this.diagnostics) : null;
  }

  getWithAppendices(id: string): IssueRecord | null {
    const result = this.get(id);
    if (!result) return null;
    result.appendices = this.listAppendices(id);
    return result;
  }

  create(input: ServerCoreIssueCreateInput): IssueRecord {
    const title = input.title.trim();
    const description = input.description;
    if (!title) throw new Error('Issue title is empty');
    if (!description.trim()) throw new Error('Issue description is empty');
    const now = Date.now();
    const created: IssueRecord = {
      id: randomUUID(),
      title,
      description,
      repro: input.repro ?? null,
      kind: input.kind ?? 'follow-up',
      status: 'open',
      severity: input.severity ?? 'medium',
      sourceSessionId: input.sourceSessionId,
      cwd: input.cwd ?? null,
      branchName: input.branchName ?? null,
      logsRef: input.logsRef ?? null,
      resolutionSessionId: null,
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      deletedAt: null,
    };
    this.database().prepare(
      `INSERT INTO issues
       (id, title, description, repro, kind, status, severity, source_session_id, cwd,
        branch_name, logs_ref, resolution_session_id, labels, created_at, updated_at,
        resolved_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
    ).run(
      created.id,
      created.title,
      created.description,
      created.repro,
      created.kind,
      created.status,
      created.severity,
      created.sourceSessionId,
      created.cwd,
      created.branchName,
      created.logsRef === null ? null : JSON.stringify(created.logsRef),
      JSON.stringify(created.labels),
      created.createdAt,
      created.updatedAt,
    );
    return created;
  }

  list(options: ServerCoreIssueListOptions = {}): IssueRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (!options.includeDeleted) conditions.push('deleted_at IS NULL');
    if (options.statuses?.length) {
      conditions.push(`status IN (${options.statuses.map(() => '?').join(',')})`);
      params.push(...options.statuses);
    }
    if (options.kinds?.length) {
      conditions.push(`kind IN (${options.kinds.map(() => '?').join(',')})`);
      params.push(...options.kinds);
    }
    if (options.titleKeyword?.trim()) {
      conditions.push('LOWER(title) LIKE ?');
      params.push(`%${options.titleKeyword.trim().toLowerCase()}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.database().prepare(
      `SELECT * FROM issues ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ).all(...params, options.limit ?? 100, options.offset ?? 0) as IssueRow[];
    return rows.map((row) => record(row, this.diagnostics));
  }

  update(id: string, patch: IssueUpdatePatchDto): IssueRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const columns: Record<keyof IssueUpdatePatchDto, string> = {
      title: 'title',
      description: 'description',
      repro: 'repro',
      kind: 'kind',
      status: 'status',
      severity: 'severity',
      labels: 'labels',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(columns) as (keyof IssueUpdatePatchDto)[]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      params.push(key === 'labels' ? JSON.stringify(patch.labels ?? []) : patch[key] ?? null);
    }
    if (patch.status === 'resolved' && existing.status !== 'resolved') {
      sets.push('resolved_at = ?');
      params.push(Date.now());
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.database().prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  linkResolutionSession(
    id: string,
    sessionId: string,
    expectedUpdatedAt: number,
  ): IssueRecord | null {
    const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1);
    const changed = this.database().prepare(
      `UPDATE issues
          SET resolution_session_id = ?, status = 'in-progress', updated_at = ?
        WHERE id = ? AND updated_at = ? AND deleted_at IS NULL AND status != 'resolved'`,
    ).run(sessionId, updatedAt, id, expectedUpdatedAt);
    return changed.changes === 1 ? this.get(id) : null;
  }

  softDelete(id: string): boolean {
    const now = Date.now();
    return this.database().prepare(
      'UPDATE issues SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(now, now, id).changes > 0;
  }

  undelete(id: string): boolean {
    return this.database().prepare(
      'UPDATE issues SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
    ).run(Date.now(), id).changes > 0;
  }

  listAppendices(issueId: string): IssueAppendix[] {
    const rows = this.database().prepare(
      'SELECT * FROM issue_appendices WHERE issue_id = ? ORDER BY appended_at ASC, id ASC',
    ).all(issueId) as AppendixRow[];
    return rows.map((row) => appendix(row, this.diagnostics));
  }

  appendContext(input: ServerCoreIssueAppendInput): IssueRecord | null {
    const updated = this.database().transaction((): boolean => {
      const existing = this.get(input.issueId);
      if (!existing) return false;
      const now = Date.now();
      this.database().prepare(
        `INSERT INTO issue_appendices
           (issue_id, body, logs_ref, appended_session_id, appended_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.issueId,
        input.body,
        input.logsRef == null ? null : JSON.stringify(input.logsRef),
        input.appendedSessionId,
        now,
      );
      const logsRef = input.logsRef == null
        ? existing.logsRef
        : mergeIssueLogsRef(existing.logsRef, input.logsRef, now);
      this.database().prepare(
        'UPDATE issues SET logs_ref = ?, updated_at = ? WHERE id = ?',
      ).run(logsRef === null ? null : JSON.stringify(logsRef), now, input.issueId);
      return true;
    })();
    return updated ? this.getWithAppendices(input.issueId) : null;
  }

  updateStatusWithNote(input: {
    readonly issueId: string;
    readonly status: IssueStatus;
    readonly note?: string;
    readonly appendedSessionId: string;
  }): IssueRecord | null {
    const updated = this.database().transaction((): boolean => {
      const existing = this.get(input.issueId);
      if (!existing) return false;
      const now = Date.now();
      if (input.note !== undefined) {
        this.database().prepare(
          `INSERT INTO issue_appendices
             (issue_id, body, logs_ref, appended_session_id, appended_at)
           VALUES (?, ?, NULL, ?, ?)`,
        ).run(input.issueId, input.note, input.appendedSessionId, now);
      }
      const resolvedAt = input.status === 'resolved' && existing.status !== 'resolved'
        ? now
        : existing.resolvedAt;
      this.database().prepare(
        `UPDATE issues
            SET status = ?, resolved_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(input.status, resolvedAt, now, input.issueId);
      return true;
    })();
    return updated ? this.getWithAppendices(input.issueId) : null;
  }
}
