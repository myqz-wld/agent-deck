import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  isJsonValue,
  parseIssueGetParams,
  parseIssueGetResult,
  parseIssueListParams,
  parseIssueListResult,
  parseIssueMutationResult,
  parseIssueResolveInNewSessionParams,
  parseIssueResolveInNewSessionResult,
  parseIssueUpdateParams,
  parseSessionConsoleCreateResult,
  type CoreMethod,
  type IssueDto,
  type IssueResolveInNewSessionResult,
  type IssueUpdatePatchDto,
  type JsonValue,
} from '@contracts/index';
import type {
  AuthoritativeSessionConsolePort,
  SessionConsoleExecutionContext,
} from '@core/session-console';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { IssueAppendix, IssueRecord, IssueStatus } from '@shared/types';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import { canonicalJson } from './runtime-validation';
import { projectServerCoreIssue } from './issue-projection';

export const SERVER_CORE_ISSUE_METHODS = Object.freeze([
  'issues.list',
  'issues.get',
  'issues.update',
  'issues.soft-delete',
  'issues.undelete',
  'issues.resolve-in-new-session',
] as const satisfies readonly CoreMethod[]);

type IssueMethod = (typeof SERVER_CORE_ISSUE_METHODS)[number];

interface IssueListOptions {
  statuses?: IssueStatus[];
  kinds?: string[];
  titleKeyword?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface ServerCoreIssueRepositoryPort {
  get(id: string): IssueRecord | null;
  list(options?: IssueListOptions): IssueRecord[];
  listAppendices(issueId: string): IssueAppendix[];
  update(id: string, patch: IssueUpdatePatchDto): IssueRecord | null;
  softDelete(id: string): boolean;
  undelete(id: string): boolean;
  linkResolutionSession(
    id: string,
    sessionId: string,
    expectedUpdatedAt: number,
  ): IssueRecord | null;
}

export interface ServerCoreIssueMetadataPort {
  currentRevision(): number;
  appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  claimMutation(
    identity: ServerCoreMutationIdentity,
    now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim;
  completeMutation(identity: ServerCoreMutationIdentity, result: JsonValue, revision: number): void;
}

export interface ServerCoreIssueRuntimeOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly issues: ServerCoreIssueRepositoryPort;
  readonly metadata: ServerCoreIssueMetadataPort;
  readonly sessionConsole: Pick<AuthoritativeSessionConsolePort, 'createSession'>;
  readonly rollbackSession: (adapterId: string, sessionId: string) => Promise<void>;
}

function issueMethod(method: CoreMethod): method is IssueMethod {
  return (SERVER_CORE_ISSUE_METHODS as readonly CoreMethod[]).includes(method);
}

function replayResult(claim: ServerCoreMutationClaim): DaemonRequestResult | null {
  if (claim.state === 'claimed') return null;
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'Mutation revision or idempotency does not match',
    );
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier mutation outcome is uncertain',
    );
  }
  if (!isJsonValue(claim.result)) throw new Error('Stored issue mutation result is invalid');
  return { result: claim.result, revision: claim.revision };
}

/** Adds bounded desktop-only Issue reads and mutations around the authoritative Core store. */
export class ServerCoreIssueRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreIssueRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_ISSUE_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> {
    return this.base.start();
  }

  stop(reason: string): Promise<void> {
    return this.base.stop(reason);
  }

  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!issueMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    switch (input.method) {
      case 'issues.list': return this.list(input);
      case 'issues.get': return this.get(input);
      case 'issues.update': return this.update(input);
      case 'issues.soft-delete': return this.softDelete(input);
      case 'issues.undelete': return this.undelete(input);
      case 'issues.resolve-in-new-session': return this.resolveInNewSession(input);
    }
  }

  private list(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseIssueListParams(input.params);
    const rows = this.options.issues.list({
      ...(params.statuses.length > 0 ? { statuses: params.statuses } : {}),
      ...(params.kinds.length > 0 ? { kinds: params.kinds } : {}),
      ...(params.titleKeyword ? { titleKeyword: params.titleKeyword } : {}),
      includeDeleted: params.includeDeleted,
      limit: params.limit + 1,
      offset: params.offset,
    });
    const revision = this.options.metadata.currentRevision();
    const result = parseIssueListResult({
      issues: rows.slice(0, params.limit).map((row) => this.project(row, [])),
      revision,
      truncated: rows.length > params.limit,
    }, params.limit);
    return this.result(result, revision);
  }

  private get(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseIssueGetParams(input.params);
    const record = this.options.issues.get(params.issueId);
    const revision = this.options.metadata.currentRevision();
    const result = parseIssueGetResult({
      issue: record ? this.project(record, this.options.issues.listAppendices(record.id)) : null,
      revision,
    }, params.issueId);
    return this.result(result, revision);
  }

  private update(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseIssueUpdateParams(input.params);
    return this.mutate(input, params.issueId, 'issue.updated', () => {
      const record = this.options.issues.update(params.issueId, params.patch);
      return this.requireIssue(record, params.issueId);
    });
  }

  private softDelete(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseIssueGetParams(input.params);
    return this.mutate(input, params.issueId, 'issue.soft-deleted', () => {
      if (!this.options.issues.softDelete(params.issueId)) this.notFound();
      return this.requireIssue(this.options.issues.get(params.issueId), params.issueId);
    });
  }

  private undelete(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseIssueGetParams(input.params);
    return this.mutate(input, params.issueId, 'issue.undeleted', () => {
      if (!this.options.issues.undelete(params.issueId)) this.notFound();
      return this.requireIssue(this.options.issues.get(params.issueId), params.issueId);
    });
  }

  private async resolveInNewSession(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseIssueResolveInNewSessionParams(input.params);
    const identity = this.mutationIdentity(input);
    const claim = this.options.metadata.claimMutation(
      identity,
      Date.now(),
      input.expectedRevision ?? undefined,
    );
    if (claim.state === 'completed') {
      const result = parseIssueResolveInNewSessionResult(claim.result, params.issueId);
      return this.result(result, claim.revision);
    }
    if (claim.state === 'conflict') {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Conflict,
        'Mutation revision or idempotency does not match',
      );
    }
    const createContext: SessionConsoleExecutionContext = {
      access: input.access,
      deadlineAt: input.deadlineAt,
      expectedRevision: input.expectedRevision,
      idempotencyKey: this.childCreateId(identity),
      signal: input.signal,
    };
    const created = parseSessionConsoleCreateResult(
      await this.options.sessionConsole.createSession(params.create, createContext),
    );
    const current = this.options.issues.get(params.issueId);
    if (current?.resolutionSessionId === created.sessionId) {
      return this.completeResolution(identity, current, created.sessionId, true);
    }
    if (
      input.signal.aborted || !current || current.deletedAt !== null ||
      current.status === 'resolved' || current.updatedAt !== params.issueUpdatedAt
    ) {
      await this.rollbackCreatedSession(params.create.adapterId, created.sessionId);
      throw new DaemonRequestError(
        input.signal.aborted
          ? AgentDeckClientErrorCode.Cancelled
          : AgentDeckClientErrorCode.Conflict,
        input.signal.aborted
          ? 'Request was cancelled'
          : 'Issue changed before the resolution session could be linked',
      );
    }
    const linked = this.options.issues.linkResolutionSession(
      params.issueId,
      created.sessionId,
      params.issueUpdatedAt,
    );
    if (!linked) {
      await this.rollbackCreatedSession(params.create.adapterId, created.sessionId);
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Conflict,
        'Issue changed before the resolution session could be linked',
      );
    }
    return this.completeResolution(identity, linked, created.sessionId, false);
  }

  private async mutate(
    input: DaemonRequestInput,
    issueId: string,
    kind: string,
    operation: () => IssueRecord,
  ): Promise<DaemonRequestResult> {
    const identity = this.mutationIdentity(input);
    const replay = replayResult(this.options.metadata.claimMutation(
      identity,
      Date.now(),
      input.expectedRevision ?? undefined,
    ));
    if (replay) return replay;
    const record = operation();
    const revision = this.options.metadata.appendChange(kind, issueId, {
      issueId,
      method: input.method,
    });
    const result = parseIssueMutationResult({
      issue: this.project(record, this.options.issues.listAppendices(issueId)),
      revision,
    }, issueId);
    const wire = this.result(result, revision);
    this.options.metadata.completeMutation(identity, wire.result, revision);
    return wire;
  }

  private mutationIdentity(input: DaemonRequestInput): ServerCoreMutationIdentity {
    if (!input.idempotencyKey) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InvalidRequest,
        'Stable idempotency is required',
      );
    }
    return {
      accessCredentialId: input.access.accessCredentialId,
      accessSurface: input.access.surface,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      requestFingerprint: createHash('sha256')
        .update(`${input.method}\u0000${canonicalJson(input.params)}`).digest('hex'),
    };
  }

  private childCreateId(identity: ServerCoreMutationIdentity): string {
    const digest = createHash('sha256').update(
      `${identity.idempotencyKey}\u0000${identity.requestFingerprint}`,
    ).digest('hex');
    return `issue-resolution-session:${digest}`;
  }

  private completeResolution(
    identity: ServerCoreMutationIdentity,
    record: IssueRecord,
    sessionId: string,
    recovered: boolean,
  ): DaemonRequestResult {
    const revision = this.options.metadata.appendChange(
      'issue.resolution-session-linked',
      record.id,
      { issueId: record.id, recovered, sessionId },
    );
    const result: IssueResolveInNewSessionResult = parseIssueResolveInNewSessionResult({
      issue: this.project(record, this.options.issues.listAppendices(record.id)),
      revision,
      sessionId,
    }, record.id);
    const wire = this.result(result, revision);
    this.options.metadata.completeMutation(identity, wire.result, revision);
    return wire;
  }

  private async rollbackCreatedSession(adapterId: string, sessionId: string): Promise<void> {
    try {
      await this.options.rollbackSession(adapterId, sessionId);
    } catch {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.ProviderLost,
        'Resolution session rollback did not complete',
        false,
      );
    }
  }

  private project(record: IssueRecord, appendices: readonly IssueAppendix[]): IssueDto {
    return projectServerCoreIssue(record, appendices, this.options);
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Issue result is not JSON-safe');
    return { result: value, revision };
  }

  private requireIssue(record: IssueRecord | null, expectedId: string): IssueRecord {
    if (!record || record.id !== expectedId) this.notFound();
    return record;
  }

  private notFound(): never {
    throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Issue was not found');
  }
}
