import { isAbsolute, relative, sep } from 'node:path';

import {
  AgentDeckClientErrorCode,
  PENDING_INDEX_MAX_REQUESTS_PER_BUCKET,
  PENDING_INDEX_MAX_REQUESTS_PER_PAGE,
  SESSION_PRESENTATION_MAX_CONTEXT_ROWS,
  SESSION_PRESENTATION_MAX_TEXT_BYTES,
  isCoreMethodAllowed,
  parsePendingIndexListParams,
  parsePendingIndexListResult,
  parseSessionPresentationListParams,
  parseSessionPresentationListResult,
  type CoreMethod,
  type JsonValue,
  type PendingIndexBucketDto,
  type SessionPresentationKind,
  type SessionPresentationSummaryDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionPresentationPage } from '@main/store/session-repo/presentation';
import type { SessionRecord, SessionTeamMembership, SummaryRecord } from '@shared/types';

import type { ServerCoreProject } from './project-catalog';
import { redactRemoteSensitiveText, hasRemoteSensitiveValue } from './remote-sensitive-data';
import { listServerCorePendingRequests } from './runtime-pending';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';

export const SERVER_CORE_SESSION_PRESENTATION_METHODS = Object.freeze([
  'pending.index.list',
  'session.presentation.list',
] as const satisfies readonly CoreMethod[]);

type PresentationMethod = (typeof SERVER_CORE_SESSION_PRESENTATION_METHODS)[number];
const MAX_PENDING_SCAN_SESSIONS = 4_096;
const MAX_PENDING_BUCKETS = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export interface ServerCoreSessionPresentationRepositoryPort {
  listLive(limit: number, offset: number, maximumContextRows: number): SessionPresentationPage;
  listHistory(query: string | undefined, limit: number, offset: number): SessionPresentationPage;
  counts(kind: SessionPresentationKind, query?: string): {
    total: number;
    active: number;
    dormant: number;
    closed: number;
    working: number;
    waiting: number;
  };
  listPendingCandidates(limit: number): SessionRecord[];
  memberships(sessionIds: string[]): Map<string, SessionTeamMembership[]>;
  summaries(sessionIds: string[]): Record<string, SummaryRecord>;
}

export interface ServerCoreSessionPresentationRuntimeOptions {
  readonly repository: ServerCoreSessionPresentationRepositoryPort;
  readonly registry: { get(adapterId: string): AgentAdapter | undefined };
  readonly presentations: Pick<ServerCoreMcpPresentationPort, 'list'>;
  readonly projects: readonly ServerCoreProject[];
  readonly workspaceRoot: string;
  readonly currentRevision: () => number;
}

function isPresentationMethod(method: CoreMethod): method is PresentationMethod {
  return (SERVER_CORE_SESSION_PRESENTATION_METHODS as readonly CoreMethod[]).includes(method);
}

function cursor(kind: SessionPresentationKind | 'pending', revision: number, offset: number): string {
  return `v1:${kind}:${revision}:${offset}`;
}

function cursorOffset(
  value: string | undefined,
  kind: SessionPresentationKind | 'pending',
  revision: number,
): number {
  if (value === undefined) return 0;
  const match = /^v1:(history|live|pending):([0-9]{1,16}):([1-9][0-9]{0,8})$/u.exec(value);
  if (!match || match[1] !== kind || Number(match[2]) !== revision) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'The list changed; refresh before loading more',
    );
  }
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset)) {
    throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Cursor is invalid');
  }
  return offset;
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) return value;
  const marker = '…';
  let cut = Math.max(0, maximum - Buffer.byteLength(marker));
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

function safeText(value: string, maximum: number): string {
  const projected = redactRemoteSensitiveText(value, () => 'Workspace')
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateUtf8(projected, maximum);
}

function safeOptionalLabel(
  value: string | null | undefined,
  maximum = 512,
): string | null {
  const normalized = value?.trim();
  if (!normalized || hasRemoteSensitiveValue(normalized)) return null;
  return safeText(normalized, maximum) || null;
}

function workspaceLabel(
  record: SessionRecord,
  projects: readonly ServerCoreProject[],
  workspaceRoot: string,
): string | null {
  const candidates = projects.filter((project) => {
    const relation = relative(project.workspacePath, record.cwd);
    return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  }).sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  const project = candidates[0];
  if (project) return safeOptionalLabel(project.title ?? project.alias);
  const relation = relative(workspaceRoot, record.cwd);
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
    ? 'Workspace'
    : null;
}

function projectSession(
  record: SessionRecord,
  contextOnly: boolean,
  memberships: ReadonlyMap<string, SessionTeamMembership[]>,
  summaries: Readonly<Record<string, SummaryRecord>>,
  projects: readonly ServerCoreProject[],
  workspaceRoot: string,
): SessionPresentationSummaryDto {
  const context = record.contextUsage
    ? {
        usedTokens: record.contextUsage.usedTokens,
        windowTokens: record.contextUsage.windowTokens,
      }
    : null;
  return {
    id: record.id,
    adapterId: record.agentId,
    title: safeText(record.title || '未命名会话', 512) || '未命名会话',
    source: record.source,
    lifecycle: record.lifecycle,
    activity: record.activity,
    archived: record.archivedAt !== null,
    pinned: record.pinnedAt != null,
    createdAt: record.startedAt,
    updatedAt: record.lastEventAt,
    endedAt: record.endedAt,
    model: safeOptionalLabel(record.model),
    thinking: safeOptionalLabel(record.thinking),
    runtimeProvider: safeOptionalLabel(record.runtimeProvider),
    context,
    spawnedBy: record.spawnedBy ?? null,
    spawnDepth: Math.min(Math.max(record.spawnDepth ?? 0, 0), 32),
    teams: (memberships.get(record.id) ?? []).slice(0, 16).map((team) => ({
      teamId: team.teamId,
      teamName: safeText(team.teamName, 512) || '未命名团队',
      role: team.role,
      joinedAt: team.joinedAt,
    })),
    summary: summaries[record.id]
      ? safeOptionalLabel(summaries[record.id]!.content, SESSION_PRESENTATION_MAX_TEXT_BYTES)
      : null,
    workspaceLabel: workspaceLabel(record, projects, workspaceRoot),
    contextOnly,
  };
}

/** Desktop-only typed list and aggregate Pending projection. */
export class ServerCoreSessionPresentationRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreSessionPresentationRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_SESSION_PRESENTATION_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(access: DaemonRequestInput['access']): Promise<number> | number {
    return this.base.currentRevision(access);
  }

  execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isPresentationMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    return Promise.resolve(input.method === 'session.presentation.list'
      ? this.list(input)
      : this.pending(input));
  }

  private list(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseSessionPresentationListParams(input.params);
    const revision = this.options.currentRevision();
    const offset = cursorOffset(params.cursor, params.kind, revision);
    const page = params.kind === 'live'
      ? this.options.repository.listLive(
          params.limit,
          offset,
          SESSION_PRESENTATION_MAX_CONTEXT_ROWS,
        )
      : this.options.repository.listHistory(params.query, params.limit, offset);
    const counts = this.options.repository.counts(params.kind, params.query);
    const primaryCount = page.records.filter((row) => !row.contextOnly).length;
    const nextOffset = offset + primaryCount;
    const sessions = this.project(page.records);
    const result = parseSessionPresentationListResult({
      sessions,
      nextCursor: nextOffset < counts.total ? cursor(params.kind, revision, nextOffset) : null,
      counts,
      contextTruncated: page.contextTruncated,
      revision,
    }, params.limit);
    return { result: result as unknown as JsonValue, revision };
  }

  private pending(input: DaemonRequestInput): DaemonRequestResult {
    const params = parsePendingIndexListParams(input.params);
    const revision = this.options.currentRevision();
    const offset = cursorOffset(params.cursor, 'pending', revision);
    const candidates = this.options.repository.listPendingCandidates(MAX_PENDING_SCAN_SESSIONS + 1);
    let scanTruncated = candidates.length > MAX_PENDING_SCAN_SESSIONS;
    const buckets: Array<{ record: SessionRecord; requests: ReturnType<typeof listServerCorePendingRequests> }> = [];
    let totalBuckets = 0;
    let totalRequests = 0;
    for (const record of candidates.slice(0, MAX_PENDING_SCAN_SESSIONS)) {
      const adapter = this.options.registry.get(record.agentId);
      if (!adapter) continue;
      const requests = listServerCorePendingRequests(
        adapter,
        record.id,
        record.startedAt,
        this.options.presentations,
      ).filter((request) => request.status === 'pending');
      if (requests.length === 0) continue;
      totalBuckets += 1;
      totalRequests += requests.length;
      if (buckets.length < MAX_PENDING_BUCKETS) buckets.push({ record, requests });
      else scanTruncated = true;
    }
    const selected: typeof buckets = [];
    let returnedRequests = 0;
    for (const bucket of buckets.slice(offset, offset + params.limit)) {
      const bounded = bucket.requests.slice(0, PENDING_INDEX_MAX_REQUESTS_PER_BUCKET);
      if (returnedRequests + bounded.length > PENDING_INDEX_MAX_REQUESTS_PER_PAGE) break;
      if (bounded.length < bucket.requests.length) scanTruncated = true;
      selected.push({ record: bucket.record, requests: bounded });
      returnedRequests += bounded.length;
    }
    const projections = this.project(selected.map((bucket) => ({
      record: bucket.record,
      contextOnly: false,
    })));
    const projectedById = new Map(projections.map((session) => [session.id, session]));
    const resultBuckets: PendingIndexBucketDto[] = selected.map((bucket) => ({
      session: projectedById.get(bucket.record.id)!,
      requests: bucket.requests,
      revision,
    }));
    const nextOffset = offset + resultBuckets.length;
    const result = parsePendingIndexListResult({
      buckets: resultBuckets,
      nextCursor: nextOffset < buckets.length ? cursor('pending', revision, nextOffset) : null,
      totalBuckets,
      totalRequests,
      scanTruncated,
      revision,
    }, params.limit);
    return { result: result as unknown as JsonValue, revision };
  }

  private project(rows: SessionPresentationPage['records']): SessionPresentationSummaryDto[] {
    const ids = rows.map((row) => row.record.id);
    const memberships = this.options.repository.memberships(ids);
    const summaries = this.options.repository.summaries(ids);
    return rows.map((row) => projectSession(
      row.record,
      row.contextOnly,
      memberships,
      summaries,
      this.options.projects,
      this.options.workspaceRoot,
    ));
  }
}
