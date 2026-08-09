import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { TaskRecord, TaskStatus } from '@shared/types';

const MAX_TEAM_SCOPE = 500;

interface TaskRow {
  id: string;
  owner_session_id: string;
  team_id: string | null;
  subject: string;
  description: string | null;
  status: string;
  active_form: string | null;
  priority: number;
  blocks: string;
  blocked_by: string;
  labels: string;
  created_at: string;
  updated_at: string;
}

export interface ServerCoreSessionTaskReadDiagnostics {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface ServerCoreTaskCreateInput {
  ownerSessionId: string;
  teamId?: string | null;
  subject: string;
  description?: string | null;
  status?: TaskStatus;
  activeForm?: string | null;
  priority?: number;
  blocks?: string[];
  blockedBy?: string[];
  labels?: string[];
}

export interface ServerCoreTaskListOptions {
  status?: TaskStatus;
  subjectKeyword?: string;
  ownerSessionIds?: string[];
  teamIdFilter?: string | 'null-personal';
  visibleScope?: { teamIds: string[]; callerSid: string };
  limit?: number;
  offset?: number;
}

function safeWarn(
  diagnostics: ServerCoreSessionTaskReadDiagnostics,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  try {
    diagnostics.warn(message, details);
  } catch {
    // Diagnostics cannot change task visibility or bounded read behavior.
  }
}

function stringList(
  raw: string,
  field: 'blockedBy' | 'blocks' | 'labels',
  diagnostics: ServerCoreSessionTaskReadDiagnostics,
): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Use the same bounded empty-list fallback as the desktop task repository.
  }
  safeWarn(diagnostics, 'task relation field is invalid', {
    action: 'task-read',
    field,
    outcome: 'invalid',
    source: 'task-storage',
  });
  return [];
}

function record(
  row: TaskRow,
  diagnostics: ServerCoreSessionTaskReadDiagnostics,
): TaskRecord {
  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    teamId: row.team_id,
    subject: row.subject,
    description: row.description,
    status: row.status as TaskStatus,
    activeForm: row.active_form,
    priority: row.priority,
    blocks: stringList(row.blocks, 'blocks', diagnostics),
    blockedBy: stringList(row.blocked_by, 'blockedBy', diagnostics),
    labels: stringList(row.labels, 'labels', diagnostics),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Core-owned task repository preserving the authenticated session's visibility semantics. */
export class ServerCoreSessionTaskReadRepository {
  constructor(
    private readonly database: () => Database,
    private readonly diagnostics: ServerCoreSessionTaskReadDiagnostics,
  ) {}

  get(id: string): TaskRecord | null {
    const row = this.database().prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;
    return row ? record(row, this.diagnostics) : null;
  }

  activeTeamIds(sessionId: string): string[] {
    const rows = this.database().prepare(
      `SELECT m.team_id
       FROM agent_deck_team_members m
       INNER JOIN agent_deck_teams t ON m.team_id = t.id
       WHERE m.session_id = ? AND m.left_at IS NULL AND t.archived_at IS NULL
       ORDER BY m.joined_at DESC
       LIMIT ?`,
    ).all(sessionId, MAX_TEAM_SCOPE + 1) as Array<{ team_id: string }>;
    if (rows.length > MAX_TEAM_SCOPE) {
      safeWarn(this.diagnostics, 'task team scope exceeds its bounded read ceiling', {
        action: 'task-read', count: rows.length, outcome: 'personal-only', source: 'task-storage',
      });
      return [];
    }
    return rows.map((row) => row.team_id);
  }

  create(input: ServerCoreTaskCreateInput): TaskRecord {
    const subject = input.subject.trim();
    if (!subject || !input.ownerSessionId) throw new Error('Task identity is invalid');
    const now = new Date().toISOString();
    const created: TaskRecord = {
      id: randomUUID(),
      ownerSessionId: input.ownerSessionId,
      teamId: input.teamId ?? null,
      subject,
      description: input.description ?? null,
      status: input.status ?? 'pending',
      activeForm: input.activeForm ?? null,
      priority: input.priority ?? 5,
      blocks: input.blocks ?? [],
      blockedBy: input.blockedBy ?? [],
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.database().prepare(
      `INSERT INTO tasks
       (id, owner_session_id, team_id, subject, description, status, active_form, priority,
        blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      created.id, created.ownerSessionId, created.teamId, created.subject,
      created.description, created.status, created.activeForm, created.priority,
      JSON.stringify(created.blocks), JSON.stringify(created.blockedBy),
      JSON.stringify(created.labels), created.createdAt, created.updatedAt,
    );
    return created;
  }

  update(id: string, patch: Partial<ServerCoreTaskCreateInput>): TaskRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const columns: Record<string, string> = {
      teamId: 'team_id', subject: 'subject', description: 'description', status: 'status',
      activeForm: 'active_form', priority: 'priority', blocks: 'blocks',
      blockedBy: 'blocked_by', labels: 'labels',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(columns) as Array<keyof ServerCoreTaskCreateInput>) {
      if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
      const value = patch[key];
      if (key === 'subject' && (!value || !String(value).trim())) {
        throw new Error('Task subject cannot be empty');
      }
      sets.push(`${columns[key]} = ?`);
      params.push(
        key === 'blocks' || key === 'blockedBy' || key === 'labels'
          ? JSON.stringify(value ?? [])
          : value ?? null,
      );
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    this.database().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  list(options: ServerCoreTaskListOptions = {}): TaskRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.subjectKeyword?.trim()) {
      const escaped = options.subjectKeyword.trim().toLowerCase()
        .replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push("LOWER(subject) LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    if (options.visibleScope) {
      const teamIds = options.visibleScope.teamIds.slice(0, MAX_TEAM_SCOPE);
      if (teamIds.length > 0 && options.visibleScope.teamIds.length <= MAX_TEAM_SCOPE) {
        conditions.push(
          `(team_id IN (${teamIds.map(() => '?').join(',')}) OR ` +
          '(team_id IS NULL AND owner_session_id = ?))',
        );
        params.push(...teamIds, options.visibleScope.callerSid);
      } else {
        conditions.push('(team_id IS NULL AND owner_session_id = ?)');
        params.push(options.visibleScope.callerSid);
      }
    } else {
      if (options.ownerSessionIds) {
        if (options.ownerSessionIds.length === 0 || options.ownerSessionIds.length > 500) return [];
        conditions.push(`owner_session_id IN (${options.ownerSessionIds.map(() => '?').join(',')})`);
        params.push(...options.ownerSessionIds);
      }
      if (options.teamIdFilter === 'null-personal') conditions.push('team_id IS NULL');
      else if (options.teamIdFilter !== undefined) {
        conditions.push('team_id = ?');
        params.push(options.teamIdFilter);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.database().prepare(
      `SELECT * FROM tasks ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ).all(...params, options.limit ?? 100, options.offset ?? 0) as TaskRow[];
    return rows.map((row) => record(row, this.diagnostics));
  }

  delete(
    id: string,
    options: {
      cascade?: boolean;
      predicate?: (
        id: string,
        task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
      ) => boolean;
    } = {},
  ): string[] {
    const target = this.get(id);
    if (!target) return [];
    const deleted = new Set<string>([id]);
    if (options.cascade) {
      const queue = [...target.blocks];
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (deleted.has(next)) continue;
        const child = this.get(next);
        if (!child || (options.predicate && !options.predicate(next, child))) continue;
        deleted.add(next);
        queue.push(...child.blocks);
      }
    }
    this.database().transaction(() => {
      const values = [...deleted];
      for (let offset = 0; offset < values.length; offset += 500) {
        const chunk = values.slice(offset, offset + 500);
        this.database().prepare(
          `DELETE FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ).run(...chunk);
      }
      const survivors = this.database().prepare(
        'SELECT id, blocks, blocked_by FROM tasks',
      ).all() as Array<Pick<TaskRow, 'id' | 'blocks' | 'blocked_by'>>;
      const update = this.database().prepare(
        'UPDATE tasks SET blocks = ?, blocked_by = ? WHERE id = ?',
      );
      for (const survivor of survivors) {
        const blocks = stringList(survivor.blocks, 'blocks', this.diagnostics)
          .filter((item) => !deleted.has(item));
        const blockedBy = stringList(survivor.blocked_by, 'blockedBy', this.diagnostics)
          .filter((item) => !deleted.has(item));
        update.run(JSON.stringify(blocks), JSON.stringify(blockedBy), survivor.id);
      }
    })();
    return [...deleted];
  }

  listForSession(sessionId: string, limit: number): TaskRecord[] {
    return this.list({
      visibleScope: { teamIds: this.activeTeamIds(sessionId), callerSid: sessionId },
      limit,
    });
  }
}
