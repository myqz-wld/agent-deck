import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isJsonObject,
  isOwnerEquivalentClient,
  type JsonValue,
  type ProjectListParams,
  type ProjectListResult,
  type ProjectResolveResult,
  type SessionConsoleCreateParams,
  type SessionConsoleCreateResult,
  type SessionConsoleGetResult,
  type SessionConsoleListParams,
  type SessionConsoleListResult,
  type SessionConsoleSummaryDto,
} from '@contracts/index';
import type {
  AuthoritativeSessionConsolePort,
  SessionConsoleExecutionContext,
} from '@core/session-console';
import { DaemonRequestError } from '@hosts/daemon';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import {
  publicServerCoreProject,
  resolveServerCoreProjectWorkspace,
  resolveServerCoreWorkspaceDirectory,
  type ServerCoreProject,
} from './project-catalog';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

export interface ServerCoreSessionConsoleRepositoryPort {
  get(sessionId: string): SessionRecord | null;
  listLive(limit: number, offset: number): SessionRecord[];
  listHistory(limit: number, offset: number): SessionRecord[];
  countLive(): number;
  countHistory(): number;
}

export interface ServerCoreSessionConsoleRegistryPort {
  get(adapterId: string): AgentAdapter | undefined;
}

export interface ServerCoreSessionConsoleMetadataPort {
  currentRevision(): number;
  appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  claimMutation(identity: ServerCoreMutationIdentity): ServerCoreMutationClaim;
  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
  ): void;
}

export interface ServerCoreSessionConsoleAuthorityOptions {
  readonly projects: readonly ServerCoreProject[];
  readonly workspaceRoot?: string;
  readonly repository: ServerCoreSessionConsoleRepositoryPort;
  readonly registry: ServerCoreSessionConsoleRegistryPort;
  readonly metadata: ServerCoreSessionConsoleMetadataPort;
}

function summary(record: SessionRecord): SessionConsoleSummaryDto {
  return Object.freeze({
    id: record.id,
    adapterId: record.agentId,
    title: record.title || null,
    status: `${record.lifecycle}-${record.activity}`,
    createdAt: record.startedAt,
    updatedAt: record.lastEventAt,
  });
}

function cursor(kind: 'history' | 'live' | 'projects', offset: number): string | null {
  return offset <= 0 ? null : `v1:${kind}:${offset}`;
}

function offset(value: string | undefined, kind: 'history' | 'live' | 'projects'): number {
  if (value === undefined) return 0;
  const match = /^v1:(history|live|projects):([1-9][0-9]{0,8})$/.exec(value);
  if (!match || match[1] !== kind) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      'Pagination cursor is invalid',
    );
  }
  const parsed = Number(match[2]);
  if (!Number.isSafeInteger(parsed)) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      'Pagination cursor is invalid',
    );
  }
  return parsed;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mutationIdentity(
  params: SessionConsoleCreateParams,
  context: SessionConsoleExecutionContext,
): ServerCoreMutationIdentity {
  if (!isOwnerEquivalentClient(context.access)) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.AccessDenied,
      'Owner-equivalent access is required',
    );
  }
  if (!context.idempotencyKey) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      'Stable idempotency is required',
    );
  }
  const fingerprint = createHash('sha256').update(canonical({
    adapterId: params.adapterId,
    initialMessage: params.initialMessage,
    options: params.options,
    workingDirectory: params.workingDirectory,
  })).digest('hex');
  return {
    accessCredentialId: context.access.accessCredentialId,
    accessSurface: context.access.surface,
    idempotencyKey: context.idempotencyKey,
    method: 'session.console.create',
    requestFingerprint: fingerprint,
  };
}

function claimResult(claim: ServerCoreMutationClaim): SessionConsoleCreateResult | null {
  if (claim.state === 'claimed') return null;
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'Idempotency key was reused for another request',
    );
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier create outcome is uncertain',
    );
  }
  if (
    !isJsonObject(claim.result) || typeof claim.result.sessionId !== 'string' ||
    claim.result.revision !== claim.revision
  ) {
    throw new Error('Stored session create result is invalid');
  }
  return { sessionId: claim.result.sessionId, revision: claim.revision };
}

/** Cwd-free authoritative project/session-console surface backed by the provider registry. */
export class ServerCoreSessionConsoleAuthority implements AuthoritativeSessionConsolePort {
  constructor(private readonly options: ServerCoreSessionConsoleAuthorityOptions) {}

  listSessions(
    params: SessionConsoleListParams,
    _context: SessionConsoleExecutionContext,
  ): SessionConsoleListResult {
    const history = params.includeArchived === true;
    const kind = history ? 'history' : 'live';
    const start = offset(params.cursor, kind);
    const total = history
      ? this.options.repository.countHistory()
      : this.options.repository.countLive();
    const records = history
      ? this.options.repository.listHistory(params.limit, start)
      : this.options.repository.listLive(params.limit, start);
    const nextOffset = start + records.length;
    return {
      sessions: records.map(summary),
      nextCursor: nextOffset < total ? cursor(kind, nextOffset) : null,
      total,
      revision: this.options.metadata.currentRevision(),
    };
  }

  getSession(
    params: { sessionId: string },
    _context: SessionConsoleExecutionContext,
  ): SessionConsoleGetResult {
    const record = this.options.repository.get(params.sessionId);
    return {
      session: record ? summary(record) : null,
      revision: this.options.metadata.currentRevision(),
    };
  }

  listProjects(
    params: ProjectListParams,
    _context: SessionConsoleExecutionContext,
  ): ProjectListResult {
    const start = offset(params.cursor, 'projects');
    const projects = this.options.projects.slice(start, start + params.limit);
    const nextOffset = start + projects.length;
    return {
      projects: projects.map(publicServerCoreProject),
      nextCursor: nextOffset < this.options.projects.length
        ? cursor('projects', nextOffset)
        : null,
      total: this.options.projects.length,
      revision: this.options.metadata.currentRevision(),
    };
  }

  resolveProject(
    params: { alias: string },
    _context: SessionConsoleExecutionContext,
  ): ProjectResolveResult {
    const project = this.options.projects.find((candidate) => candidate.alias === params.alias);
    return {
      project: project ? publicServerCoreProject(project) : null,
      revision: this.options.metadata.currentRevision(),
    };
  }

  async createSession(
    params: SessionConsoleCreateParams,
    context: SessionConsoleExecutionContext,
  ): Promise<SessionConsoleCreateResult> {
    if (Object.keys(params.options).length !== 0) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Remote session options are not supported',
      );
    }
    if (context.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    const project = this.options.projects.find(
      (candidate) => candidate.projectRef === params.workingDirectory,
    );
    const adapter = this.options.registry.get(params.adapterId);
    if (!adapter?.createSession) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.CapabilityUnavailable,
        'Adapter cannot create sessions',
      );
    }
    const identity = mutationIdentity(params, context);
    const replay = claimResult(this.options.metadata.claimMutation(identity));
    if (replay) return replay;
    let cwd: string;
    try {
      cwd = project
        ? resolveServerCoreProjectWorkspace(
            project,
            this.options.workspaceRoot ?? '/workspaces',
          )
        : resolveServerCoreWorkspaceDirectory(
            params.workingDirectory,
            this.options.workspaceRoot ?? '/workspaces',
          );
    } catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Working directory is outside the authorized Workspace or unavailable',
      );
    }
    const sessionId = await adapter.createSession(buildCreateSessionOptions(params.adapterId, {
      cwd,
      prompt: params.initialMessage,
      awaitCanonicalId: true,
    }));
    const revision = this.options.metadata.appendChange('session.created', sessionId, {
      adapterId: params.adapterId,
      workingDirectory: params.workingDirectory,
      sessionId,
    });
    const result = { sessionId, revision };
    this.options.metadata.completeMutation(identity, result, revision);
    return result;
  }
}
