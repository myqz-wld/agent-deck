import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  isJsonObject,
  isJsonValue,
  parseTeamAddMemberParams,
  parseTeamAddMemberResult,
  parseTeamArchiveParams,
  parseTeamGetParams,
  parseTeamGetResult,
  parseTeamListParams,
  parseTeamListResult,
  parseTeamMutationResult,
  parseTeamShutdownParams,
  parseTeamShutdownResult,
  SessionConsoleContractError,
  TEAM_EVENT_MAX_ITEMS,
  TEAM_MEMBER_MAX_ITEMS,
  TEAM_MESSAGE_MAX_ITEMS,
  TEAM_SESSION_MAX_ITEMS,
  TEAM_TASK_MAX_ITEMS,
  type CoreMethod,
  type JsonValue,
  type TeamPendingCountsDto,
  type TeamSessionDto,
  type TeamSummaryDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { SessionRecord, StoredAgentEvent, TaskRecord } from '@shared/types';
import { projectSessionEvents } from './session-event-projection';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import { canonicalJson } from './runtime-validation';

export const SERVER_CORE_TEAM_METHODS = Object.freeze([
  'teams.list',
  'teams.get',
  'teams.archive',
  'teams.add-member',
  'teams.shutdown-teammates',
] as const satisfies readonly CoreMethod[]);

type TeamMethod = (typeof SERVER_CORE_TEAM_METHODS)[number];
const PENDING_READ_CONCURRENCY = 8;

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  consume: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (failure === undefined && nextIndex < values.length) {
        const index = nextIndex++;
        try {
          results[index] = await consume(values[index]!, index);
        } catch (error) {
          failure = error;
        }
      }
    },
  ));
  if (failure !== undefined) throw failure;
  return results;
}

export interface ServerCoreTeamRuntimeOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly teams: AgentDeckTeamRepo;
  readonly messages: Pick<AgentDeckMessageRepo, 'listByTeam'>;
  readonly sessions: {
    get(sessionId: string): SessionRecord | null;
    listActiveAndDormant(limit: number, offset: number): SessionRecord[];
  };
  readonly events: { findTeamEvents(teamId: string, limit: number): StoredAgentEvent[] };
  readonly tasks: { list(options: { teamIdFilter: string; limit: number }): TaskRecord[] };
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly notifyMembershipChanged: (sessionId: string) => void;
  readonly metadata: {
    currentRevision(): number;
    appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
    claimMutation(
      identity: ServerCoreMutationIdentity,
      now?: number,
      expectedRevision?: number,
    ): ServerCoreMutationClaim;
    completeMutation(identity: ServerCoreMutationIdentity, result: JsonValue, revision: number): void;
    releaseMutationClaim(identity: ServerCoreMutationIdentity): void;
  };
}

function teamMethod(method: CoreMethod): method is TeamMethod {
  return (SERVER_CORE_TEAM_METHODS as readonly CoreMethod[]).includes(method);
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
  if (!isJsonValue(claim.result)) throw new Error('Stored team mutation result is invalid');
  return { result: claim.result, revision: claim.revision };
}

function truncate(value: string, maximum: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) return value;
  const marker = '\n…[remote view truncated]';
  let cut = Math.max(0, maximum - Buffer.byteLength(marker));
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

/** Desktop-only Team workspace backed by the authoritative Core repositories. */
export class ServerCoreTeamRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreTeamRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_TEAM_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!teamMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    try {
      switch (input.method) {
        case 'teams.list': return this.list(input);
        case 'teams.get': return this.get(input);
        case 'teams.archive': return this.archive(input);
        case 'teams.add-member': return this.addMember(input);
        case 'teams.shutdown-teammates': return this.shutdownTeammates(input);
      }
    } catch (error) {
      if (error instanceof DaemonRequestError) throw error;
      if (error instanceof SessionConsoleContractError) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
      }
      throw error;
    }
  }

  private list(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseTeamListParams(input.params);
    const revision = this.options.metadata.currentRevision();
    const teams = this.options.teams.list({
      activeOnly: !params.includeArchived,
      limit: params.limit,
    }).map((team) => this.summary(team));
    return this.result(parseTeamListResult(
      { teams, revision }, params.limit, params.includeArchived,
    ), revision);
  }

  private async get(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const { teamId } = parseTeamGetParams(input.params);
    const team = this.options.teams.getWithMembers(teamId);
    const revision = this.options.metadata.currentRevision();
    if (!team) return this.result(parseTeamGetResult({ team: null, revision }, teamId), revision);
    if (team.members.length > TEAM_MEMBER_MAX_ITEMS) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.InternalError,
        'Team exceeds remote presentation limits',
      );
    }

    const memberSessions = team.members.flatMap((member) => {
      const record = this.options.sessions.get(member.sessionId);
      return record ? [record] : [];
    });
    const byId = new Map(memberSessions.map((session) => [session.id, session]));
    const remaining = Math.max(0, TEAM_SESSION_MAX_ITEMS - byId.size);
    if (remaining > 0) {
      for (const session of this.options.sessions.listActiveAndDormant(remaining, 0)) {
        if (byId.size >= TEAM_SESSION_MAX_ITEMS) break;
        byId.set(session.id, session);
      }
    }
    const activeMembers = team.members.filter((member) => member.leftAt === null);
    const pending = await mapConcurrent(
      activeMembers,
      PENDING_READ_CONCURRENCY,
      (member, index) => this.pendingCounts(input, member.sessionId, index),
    );
    const recentEvents = this.options.events.findTeamEvents(teamId, TEAM_EVENT_MAX_ITEMS)
      .flatMap((event) => {
        const session = byId.get(event.sessionId) ?? this.options.sessions.get(event.sessionId);
        return session
          ? projectSessionEvents([event], session, 1, {
              workspaceRoot: this.options.workspaceRoot,
              privateRoots: this.options.privateRoots,
            }).events
          : [];
      });
    const tasks = team.archivedAt === null
      ? this.options.tasks.list({ teamIdFilter: teamId, limit: TEAM_TASK_MAX_ITEMS })
      : [];
    const recentMessages = this.options.messages.listByTeam(teamId, {
      limit: TEAM_MESSAGE_MAX_ITEMS,
    }).map((message) => ({
      id: message.id,
      fromSessionId: message.fromSessionId,
      toSessionId: message.toSessionId,
      body: truncate(message.body, 64 * 1024),
      status: message.status,
      statusReason: message.statusReason === null
        ? null
        : truncate(message.statusReason, 4 * 1024),
      sentAt: message.sentAt,
      replyToMessageId: message.replyToMessageId,
    }));
    const result = parseTeamGetResult({
      team: {
        id: team.id,
        name: team.name,
        createdAt: team.createdAt,
        archivedAt: team.archivedAt,
        archiveReason: team.archiveReason,
        members: team.members,
        sessions: [...byId.values()].map((session) => this.session(session)),
        pending,
        recentEvents,
        tasks,
        recentMessages,
      },
      revision,
    }, teamId);
    return this.result(result, revision);
  }

  private archive(input: DaemonRequestInput): DaemonRequestResult {
    const { teamId } = parseTeamArchiveParams(input.params);
    const claimed = this.claimMutation(input);
    if (claimed.replay) return claimed.replay;
    const team = this.options.teams.archive(teamId, { reason: 'user-action' });
    if (!team) {
      return this.releaseClaim(claimed.identity, new DaemonRequestError(
        AgentDeckClientErrorCode.NotFound,
        'Team was not found',
      ));
    }
    const revision = this.options.metadata.appendChange('team.archived', teamId, { teamId });
    return this.completeMutation(
      input,
      parseTeamMutationResult({ team: this.summary(team), revision }, teamId),
      revision,
    );
  }

  private addMember(input: DaemonRequestInput): DaemonRequestResult {
    const params = parseTeamAddMemberParams(input.params);
    const claimed = this.claimMutation(input);
    if (claimed.replay) return claimed.replay;
    try {
      const team = this.options.teams.getWithMembers(params.teamId);
      if (!team || team.archivedAt !== null) this.notFound();
      const existingMember = team.members.find((member) => member.sessionId === params.sessionId);
      if (
        team.members.length > TEAM_MEMBER_MAX_ITEMS ||
        (team.members.length === TEAM_MEMBER_MAX_ITEMS && !existingMember)
      ) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.InvalidRequest,
          'Team has reached the remote member limit',
        );
      }
      if (!this.options.sessions.get(params.sessionId)) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session was not found');
      }
    } catch (cause) {
      return this.releaseClaim(claimed.identity, cause);
    }
    const member = this.options.teams.addMember({
      teamId: params.teamId,
      sessionId: params.sessionId,
      role: params.role,
      displayName: null,
    });
    this.options.notifyMembershipChanged(params.sessionId);
    const revision = this.options.metadata.appendChange('team.member-added', params.teamId, {
      sessionId: params.sessionId,
      teamId: params.teamId,
    });
    return this.completeMutation(
      input,
      parseTeamAddMemberResult({ member, revision }, params),
      revision,
    );
  }

  private async shutdownTeammates(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const { teamId } = parseTeamShutdownParams(input.params);
    const claimed = this.claimMutation(input);
    if (claimed.replay) return claimed.replay;
    let teammates: ReturnType<AgentDeckTeamRepo['listActiveMembers']>;
    try {
      const team = this.options.teams.get(teamId);
      if (!team) this.notFound();
      teammates = this.options.teams.listActiveMembers(teamId)
        .filter((member) => member.role === 'teammate');
      if (teammates.length > TEAM_MEMBER_MAX_ITEMS) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.InternalError,
          'Team exceeds remote presentation limits',
        );
      }
    } catch (cause) {
      return this.releaseClaim(claimed.identity, cause);
    }
    const closed: string[] = [];
    const failed: Array<{ sessionId: string; reason: string }> = [];
    for (const member of teammates) {
      if (input.signal.aborted) {
        failed.push({ sessionId: member.sessionId, reason: 'Request was cancelled' });
        continue;
      }
      try {
        await this.options.closeSession(member.sessionId);
        closed.push(member.sessionId);
      } catch {
        failed.push({ sessionId: member.sessionId, reason: 'Session could not be closed' });
      }
    }
    const revision = this.options.metadata.appendChange('team.teammates-shutdown', teamId, {
      closed: closed.length,
      failed: failed.length,
      teamId,
    });
    const parsed = parseTeamShutdownResult({ closed, failed, revision });
    const wire = this.result(parsed, revision);
    this.options.metadata.completeMutation(claimed.identity, wire.result, revision);
    return wire;
  }

  private async pendingCounts(
    input: DaemonRequestInput,
    sessionId: string,
    index: number,
  ): Promise<TeamPendingCountsDto> {
    const response = await this.base.execute({
      ...input,
      requestId: `${input.requestId}:team-pending:${index}`,
      method: 'pending.list',
      params: { sessionId },
      idempotencyKey: null,
      expectedRevision: null,
    });
    if (!isJsonObject(response.result) || !Array.isArray(response.result.requests)) {
      throw new Error('Pending result is invalid');
    }
    const counts = { permissions: 0, questions: 0, plans: 0, diffs: 0 };
    for (const request of response.result.requests) {
      if (!isJsonObject(request)) throw new Error('Pending result is invalid');
      if (request.kind === 'permission') counts.permissions += 1;
      else if (request.kind === 'ask-user-question') counts.questions += 1;
      else if (request.kind === 'exit-plan') counts.plans += 1;
      else if (request.kind === 'diff-review') counts.diffs += 1;
    }
    return { sessionId, ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
  }

  private summary(team: { id: string; name: string; createdAt: number; archivedAt: number | null }): TeamSummaryDto {
    const members = this.options.teams.listActiveMembers(team.id);
    const lastEventAt = members.reduce((latest, member) => {
      const session = this.options.sessions.get(member.sessionId);
      return Math.max(latest, session?.lastEventAt ?? team.createdAt);
    }, team.createdAt);
    return {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt,
      archivedAt: team.archivedAt,
      memberCount: members.length,
      lastEventAt,
    };
  }

  private session(record: SessionRecord): TeamSessionDto {
    return {
      id: record.id,
      adapterId: record.agentId,
      title: record.title,
      lifecycle: record.lifecycle,
      lastEventAt: record.lastEventAt,
      archivedAt: record.archivedAt,
      spawnedBy: record.spawnedBy ?? null,
    };
  }

  private claimMutation(input: DaemonRequestInput): {
    identity: ServerCoreMutationIdentity;
    replay: DaemonRequestResult | null;
  } {
    const identity = this.mutationIdentity(input);
    return {
      identity,
      replay: replayResult(this.options.metadata.claimMutation(
        identity,
        Date.now(),
        input.expectedRevision ?? undefined,
      )),
    };
  }

  private releaseClaim(identity: ServerCoreMutationIdentity, cause: unknown): never {
    try { this.options.metadata.releaseMutationClaim(identity); }
    catch (releaseError) {
      throw new AggregateError([cause, releaseError], 'Team mutation claim release failed');
    }
    throw cause;
  }
  private completeMutation(
    input: DaemonRequestInput,
    result: unknown,
    revision: number,
  ): DaemonRequestResult {
    const identity = this.mutationIdentity(input);
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

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Team result is not JSON-safe');
    return { result: value, revision };
  }
  private notFound(): never {
    throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Team was not found');
  }
}
