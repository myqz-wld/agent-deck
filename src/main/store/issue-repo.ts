/**
 * Issue Tracker 持久层（plan issue-tracker-mcp-20260529 §Step 3.2 / §D9-D17）。
 *
 * agent 上报问题机制 + UI 顶层 Issues tab 看板的 SQLite 持久层。MVP 单文件 facade
 * pattern（与 task-repo facade 同款，但 issue-repo 不拆子模块 — 没有 hand_off 三态
 * 复杂度，单文件 ≤ 300 行可控）。
 *
 * 关键能力（§D 决策表）：
 * - **CRUD**: create / get / update / list / softDelete / undelete / hardDelete
 * - **D15 resolved_at 状态机**：update patch 带 status 时按 transition 写 resolved_at；
 *   不带 status 的 partial patch idempotent 不动 resolved_at（reviewer R2 LOW）
 * - **D16 append 子表**: appendContext / listAppendices — 不动 issues.description
 *   1-2000 char 不变量
 * - **D17 logsRef merge**: appendContext 带 args.logsRef 时 merge 到 issues.logs_ref
 *   （date 覆盖 / tsRange min-max 扩展 / scopes union / note append + 截断 / 32 项 normalize）
 * - **D13 GC**: listForGc — IssueLifecycleScheduler tick 用，按 thresholds 拿超期 issue id
 *
 * **DB 命名**：列名 snake_case（SQLite 惯例），TS 内部 / mcp args 全 camelCase（§D18）。
 * **timestamp**：INTEGER epoch ms（与 sessions / agent_deck_teams 一致；不与 tasks 表
 * TEXT ISO8601 对齐）。
 */
import type { Database } from 'better-sqlite3';
import type {
  IssueAppendix,
  IssueRecord,
  IssueSeverity,
  IssueStatus,
  LogsRef,
} from '@shared/types';
import log from '@main/utils/logger';
import { getDb } from './db';

const logger = log.scope('issue-repo');

// ═══════════════════════════════════════════════════════════════════════════
// Row schema (snake_case) + 类型转换 helpers
// ═══════════════════════════════════════════════════════════════════════════

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

function safeJsonParse<T>(raw: string | null, fallback: T, ctx: string): T {
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; }
  catch (e) {
    logger.warn(`[issue-repo] JSON parse 失败 (${ctx})，退化默认`, e);
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
    logsRef: safeJsonParse<LogsRef | null>(r.logs_ref, null, `issue ${r.id} logs_ref`),
    resolutionSessionId: r.resolution_session_id,
    labels: safeJsonParse<string[]>(r.labels, [], `issue ${r.id} labels`),
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
    logsRef: safeJsonParse<LogsRef | null>(r.logs_ref, null, `appendix ${r.id} logs_ref`),
    appendedSessionId: r.appended_session_id,
    appendedAt: r.appended_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// IO 接口
// ═══════════════════════════════════════════════════════════════════════════

export interface IssueCreateInput {
  title: string;
  description: string;
  repro?: string | null;
  kind?: string;
  severity?: IssueSeverity;
  sourceSessionId: string | null;
  cwd?: string | null;
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
  /** UI「Resolve in new session」起 SDK session 后回写 */
  resolutionSessionId?: string | null;
  labels?: string[];
  /** appendContext 内部用 merge 后的 logsRef；UI 端不直接走 update 改 logsRef（走 detail 编辑表单时另议） */
  logsRef?: LogsRef | null;
}

export interface IssueListOptions {
  /** 多选 status filter；不传 / 空数组 = 不过滤 */
  statuses?: IssueStatus[];
  /** 多选 kind filter；不传 / 空数组 = 不过滤 */
  kinds?: string[];
  /** subject (title) 大小写不敏感 substring 模糊匹配 */
  titleKeyword?: string;
  /** 是否包含软删；默认 false（隐藏 deleted_at IS NOT NULL） */
  includeDeleted?: boolean;
  /** 仅返回软删；与 includeDeleted=true 互斥（专门「已删除」过滤器） */
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface IssueListForGcResult {
  /** status='resolved' && resolved_at < now-resolvedRetentionDays * 86400_000 */
  resolvedExpired: string[];
  /** deleted_at IS NOT NULL && deleted_at < now-softDeletedRetentionDays * 86400_000 */
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
  /**
   * 增量更新。patch 显式 undefined 视为「不动」；显式 null 视为「清空」。
   *
   * **D15 resolved_at 状态机**（详 plan §D15 7 transition + 1 partial patch idempotent
   * 共 8 case repo 层覆盖；status zod enum reject 是 IPC 层 case 9）：
   * - patch 不带 status → idempotent 不动 resolved_at（reviewer R2 LOW 边角）
   * - 旧 != 'resolved' && 新 == 'resolved' → SET resolved_at = now（含 reopen 后再 resolve 刷新）
   * - 旧 == 'resolved' && 新 != 'resolved' → 保留旧 resolved_at（不清，让 GC 在中间不命中条件）
   * - 旧 == 'resolved' && 新 == 'resolved' → idempotent 不动（避免 user 重复点 resolve 刷 GC 时钟）
   */
  update(id: string, patch: IssueUpdateInput): IssueRecord | null;
  list(opts?: IssueListOptions): IssueRecord[];
  /** 写 deleted_at = now；UI 列表默认隐藏；超期 IssueLifecycleScheduler 硬删 */
  softDelete(id: string): boolean;
  /** 清 deleted_at；恢复显示 */
  undelete(id: string): boolean;
  /** 真删；CASCADE 自动删 issue_appendices 子表行 */
  hardDelete(id: string): boolean;
  /** §D13 GC：拿超期 issue id 列表，IssueLifecycleScheduler tick 调 hardDelete */
  listForGc(thresholds: {
    resolvedRetentionDays: number;
    softDeletedRetentionDays: number;
    nowMs?: number;
    /** 每路（resolved / softDeleted）单轮 id 上限，剩余下轮 tick 继续。默认 500（与
     *  session-repo findHistoryOlderThan 对称，防一次同步删上万行卡主线程）。REVIEW_83 LOW。 */
    limit?: number;
  }): IssueListForGcResult;
  /**
   * §D16 append 子表 INSERT + §D17 logsRef merge 到 issues.logs_ref（args.logsRef 非
   * null/undefined 时）。返回完整 IssueRecord 含 appendices 列表（D19 让 UI 直接拿全 record
   * 不必再 IPC fetch）。
   */
  appendContext(input: IssueAppendInput): IssueRecord | null;
  listAppendices(issueId: string): IssueAppendix[];
}

// ═══════════════════════════════════════════════════════════════════════════
// D17 logsRef merge 算法（appendContext 内部用）
// ═══════════════════════════════════════════════════════════════════════════

const SCOPES_MAX = 32;
const NOTE_MAX = 2000;

/**
 * §D17：merge args.logsRef → existing logsRef。
 * - date：以 args 为准覆盖（最新现场以新为准）
 * - tsRange：min(start), max(end) 扩展；其中一边 null 取非 null
 * - scopes：union 去重；post-merge >32 项 → caller args 全保留 + existing 从尾截到总数 = 32
 * - note：append "(appended <appendedAtIso>) <new note>" 到旧 note 末尾；总长 > NOTE_MAX
 *   从 note **头部** 截字符直到总长 ≤ NOTE_MAX-3，前缀 `...`（保留最新内容）
 */
function mergeLogsRef(
  existing: LogsRef | null,
  incoming: LogsRef,
  appendedAtMs: number,
): LogsRef {
  const merged: LogsRef = { date: incoming.date };
  // tsRange
  if (incoming.tsRange && existing?.tsRange) {
    merged.tsRange = {
      start: Math.min(incoming.tsRange.start, existing.tsRange.start),
      end: Math.max(incoming.tsRange.end, existing.tsRange.end),
    };
  } else if (incoming.tsRange) {
    merged.tsRange = { ...incoming.tsRange };
  } else if (existing?.tsRange) {
    merged.tsRange = { ...existing.tsRange };
  }
  // scopes union + post-merge normalize（caller args 全保留 + existing 从尾截）
  const incomingScopes = incoming.scopes ?? [];
  const existingScopes = existing?.scopes ?? [];
  const seen = new Set<string>();
  const unioned: string[] = [];
  for (const s of incomingScopes) if (!seen.has(s)) { seen.add(s); unioned.push(s); }
  for (const s of existingScopes) if (!seen.has(s)) { seen.add(s); unioned.push(s); }
  // unioned 已去重且 incoming 优先 + existing 补足；>32 直接截断（incoming 优先保留，
  // existing 从尾丢）。不要回退用 raw incomingScopes —— 那会把 incoming 内的重复项写回主表
  if (unioned.length > 0) {
    merged.scopes = unioned.slice(0, SCOPES_MAX);
  }
  // note: append (appended <iso>) <new>
  if (incoming.note != null) {
    const iso = new Date(appendedAtMs).toISOString();
    const appendedSegment = `(appended ${iso}) ${incoming.note}`;
    let combined = existing?.note != null
      ? `${existing.note}\n${appendedSegment}`
      : appendedSegment;
    if (combined.length > NOTE_MAX) {
      // 从头截：保留最新（末尾的 new note 部分），前缀 `...`
      const keepLen = NOTE_MAX - 3;
      combined = '...' + combined.slice(combined.length - keepLen);
    }
    merged.note = combined;
  } else if (existing?.note != null) {
    merged.note = existing.note;
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

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
        logs_ref, resolution_session_id, labels, created_at, updated_at, resolved_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      rec.id, rec.title, rec.description, rec.repro, rec.kind, rec.status, rec.severity,
      rec.sourceSessionId, rec.cwd, JSON.stringify(rec.logsRef ?? null) === 'null' ? null : JSON.stringify(rec.logsRef),
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
    // §D15 resolved_at 状态机
    const hasStatusPatch = Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== undefined;
    if (hasStatusPatch) {
      const oldS = existing.status;
      const newS = patch.status as IssueStatus;
      if (oldS !== 'resolved' && newS === 'resolved') {
        sets.push('resolved_at = ?'); params.push(Date.now());
      }
      // 其他 transition（resolved→non / non→non / resolved→resolved）：不动 resolved_at
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
    // REVIEW_83 LOW (reviewer-codex E2 + lead grep 对照): 每路单轮上限,与 session-repo
    // findHistoryOlderThan(threshold, limit=500) 对称。issue 是 agent 低频上报量级远小于
    // session events,但两个 latent 场景可达大批量:① retention 从 0 改非 0 首次启用 GC
    // 历史一次性全删 ② 长期 high-volume 上报后批量过期。一次同步删 N 千行 + N 千次 emit
    // 卡主线程(IssueLifecycleScheduler.scan() 是 sync 逐条 hardDelete+emit)。限 500 剩余
    // 下轮 tick 续(默认 6h)。
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
    const issue = get(input.issueId);
    if (!issue) return null;
    const now = Date.now();
    db.prepare(
      `INSERT INTO issue_appendices (issue_id, body, logs_ref, appended_session_id, appended_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.issueId, input.body,
      input.logsRef == null ? null : JSON.stringify(input.logsRef),
      input.appendedSessionId, now,
    );
    // §D17：args.logsRef 非 null/undefined 时 merge 到 issues.logs_ref
    if (input.logsRef != null) {
      const merged = mergeLogsRef(issue.logsRef, input.logsRef, now);
      db.prepare(`UPDATE issues SET logs_ref = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(merged), now, input.issueId,
      );
    } else {
      db.prepare(`UPDATE issues SET updated_at = ? WHERE id = ?`).run(now, input.issueId);
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// Default lazy singleton（与 task-repo / session-repo 同款 pattern）
// ═══════════════════════════════════════════════════════════════════════════

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
