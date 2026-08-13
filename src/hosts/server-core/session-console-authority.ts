import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isJsonObject,
  isOwnerEquivalentClient,
  type JsonValue,
  type ProjectListParams,
  type ProjectListResult,
  type ProjectResolveResult,
  type SessionConsoleCapabilitiesParams,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleAttachmentInput,
  type SessionConsoleCreateParams,
  type SessionConsoleCreateResult,
  type SessionConsoleGetResult,
  type SessionConsoleListParams,
  type SessionConsoleListResult,
  type SessionConsoleSummaryDto,
  type WorkspaceDirectoryListParams,
  type WorkspaceDirectoryListResult,
} from '@contracts/index';
import type {
  AuthoritativeSessionConsolePort,
  SessionConsoleExecutionContext,
} from '@core/session-console';
import { DaemonRequestError } from '@hosts/daemon';
import type {
  AgentAdapter,
  InitialSessionRegistration,
} from '@main/adapters/types';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
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
import { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { buildRemoteCreateOptions } from './session-create-options';
import { listServerCoreWorkspaceDirectories } from './workspace-directory-catalog';
import { serverCoreWorktreeReferenceFence } from './worktree-reference-fence';

export { buildRemoteCreateOptions } from './session-create-options';

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
  claimMutation(
    identity: ServerCoreMutationIdentity,
    now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim;
  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
  ): void;
  commitSessionCreate(
    identity: ServerCoreMutationIdentity,
    sessionId: string,
    payload: JsonValue,
  ): SessionConsoleCreateResult;
  releaseMutationClaim(identity: ServerCoreMutationIdentity): void;
}

export interface ServerCoreSessionAttachmentStorePort {
  persist(inputs: readonly SessionConsoleAttachmentInput[]): Promise<UploadedAttachmentRef[]>;
  remove(refs: readonly UploadedAttachmentRef[]): Promise<void>;
}

export interface ServerCoreSessionConsoleAuthorityOptions {
  readonly projects: readonly ServerCoreProject[];
  readonly workspaceRoot?: string;
  readonly repository: ServerCoreSessionConsoleRepositoryPort;
  readonly registry: ServerCoreSessionConsoleRegistryPort;
  readonly metadata: ServerCoreSessionConsoleMetadataPort;
  readonly createCapabilities: ServerCoreSessionCreateCapabilities;
  readonly attachmentStore: ServerCoreSessionAttachmentStorePort;
  rollbackCreatedSession(adapterId: string, sessionId: string): Promise<void>;
}

export interface ServerCoreSessionSpawnCreateInput {
  readonly params: SessionConsoleCreateParams;
  readonly initialSessionRegistration: InitialSessionRegistration;
  readonly teamName?: string;
}

interface PreparedSessionCreate {
  readonly adapter: AgentAdapter & Required<Pick<AgentAdapter, 'createSession'>>;
  readonly project: ServerCoreProject | undefined;
}

class UncertainSessionCreateError extends DaemonRequestError {
  constructor(readonly failures: readonly unknown[], message: string) {
    super(AgentDeckClientErrorCode.ProviderLost, message, true);
  }
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
    attachments: params.attachments,
    capabilityRevision: params.capabilityRevision,
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

  getCapabilities(
    params: SessionConsoleCapabilitiesParams,
    _context: SessionConsoleExecutionContext,
  ): Promise<SessionConsoleCapabilitiesResult> {
    return this.options.createCapabilities.describe(params);
  }

  listWorkspaceDirectories(
    params: WorkspaceDirectoryListParams,
    _context: SessionConsoleExecutionContext,
  ): WorkspaceDirectoryListResult {
    let result;
    try {
      result = listServerCoreWorkspaceDirectories(
        params.directory,
        this.options.workspaceRoot ?? '/workspaces',
      );
    } catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Workspace directory is outside the authorized Workspace or unavailable',
      );
    }
    return {
      directory: result.directory,
      directories: [...result.directories],
      truncated: result.truncated,
      revision: this.options.metadata.currentRevision(),
    };
  }

  async createSession(
    params: SessionConsoleCreateParams,
    context: SessionConsoleExecutionContext,
  ): Promise<SessionConsoleCreateResult> {
    if (context.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    const identity = mutationIdentity(params, context);
    const replay = claimResult(this.options.metadata.claimMutation(
      identity,
      Date.now(),
    ));
    if (replay) return replay;
    try {
      const prepared = await this.prepareProviderSession(params);
      return await this.createPreparedSession(params, prepared, {}, identity);
    } catch (cause) {
      if (cause instanceof UncertainSessionCreateError) throw cause;
      try { this.options.metadata.releaseMutationClaim(identity); } catch (releaseError) {
        throw new AggregateError([cause, releaseError], 'Session create claim release failed');
      }
      throw cause;
    }
  }

  /** Trusted Core-only spawn path; public SSH callers cannot supply registration metadata. */
  createSpawnSession(
    input: ServerCoreSessionSpawnCreateInput,
  ): Promise<SessionConsoleCreateResult> {
    return this.prepareProviderSession(input.params).then((prepared) =>
      this.createPreparedSession(input.params, prepared, {
        awaitCanonicalId: true,
        initialSessionRegistration: input.initialSessionRegistration,
        ...(input.teamName === undefined ? {} : { teamName: input.teamName }),
      }));
  }

  private async prepareProviderSession(
    params: SessionConsoleCreateParams,
  ): Promise<PreparedSessionCreate> {
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
    const capabilities = await this.options.createCapabilities.validateCreate(
      params.adapterId,
      params.capabilityRevision,
      params.workingDirectory,
      params.options,
    );
    if (params.attachments.length > 0 && !capabilities.create.attachments.enabled) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.CapabilityUnavailable,
        'Adapter cannot accept Remote image attachments',
      );
    }
    return { adapter: adapter as PreparedSessionCreate['adapter'], project };
  }

  private async createPreparedSession(
    params: SessionConsoleCreateParams,
    prepared: PreparedSessionCreate,
    internal: {
      readonly awaitCanonicalId?: boolean;
      readonly initialSessionRegistration?: InitialSessionRegistration;
      readonly teamName?: string;
    } = {},
    identity?: ServerCoreMutationIdentity,
  ): Promise<SessionConsoleCreateResult> {
    let cwd: string;
    try {
      cwd = prepared.project
        ? resolveServerCoreProjectWorkspace(
            prepared.project,
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
    const referenceLease = (() => {
      try {
        return serverCoreWorktreeReferenceFence.acquireReference(cwd);
      } catch {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.Conflict,
          'Working directory is being retired',
        );
      }
    })();
    try {
    const attachments = await this.options.attachmentStore.persist(params.attachments);
    let sessionId: string;
    try {
      sessionId = await prepared.adapter.createSession(buildRemoteCreateOptions(
        params,
        cwd,
        attachments,
        internal,
      ));
    } catch (error) {
      await this.options.attachmentStore.remove(attachments);
      throw error;
    }
    const payload = {
      adapterId: params.adapterId,
      workingDirectory: params.workingDirectory,
      sessionId,
    } as const;
    try {
      return identity
        ? this.options.metadata.commitSessionCreate(identity, sessionId, payload)
        : { sessionId, revision: this.options.metadata.appendChange(
            'session.created', sessionId, payload,
          ) };
    } catch (cause) {
      const [rollback, attachmentsRemoved] = await Promise.allSettled([
        this.options.rollbackCreatedSession(params.adapterId, sessionId),
        this.options.attachmentStore.remove(attachments),
      ]);
      const failures = [rollback, attachmentsRemoved]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (rollback.status === 'rejected') {
        throw new UncertainSessionCreateError(
          [cause, ...failures],
          'Created provider session could not be rolled back',
        );
      }
      if (failures.length > 0) {
        throw new AggregateError([cause, ...failures], 'Session create cleanup failed');
      }
      throw cause;
    }
    } finally {
      referenceLease.release();
    }
  }
}
