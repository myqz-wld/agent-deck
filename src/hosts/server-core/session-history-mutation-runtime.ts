import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  parseSessionHistoryMutationParams,
  parseSessionHistoryMutationResult,
  type CoreMethod,
  type JsonValue,
  type SessionHistoryMutationState,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { SessionRecord } from '@shared/types';

import type { ServerCoreSessionManager } from './session-manager';
import {
  claimServerCoreMutation,
  completeServerCoreMutation,
  releaseServerCoreMutation,
  type ServerCoreMutationLedgerPort,
} from './runtime-mutation-ledger';

export const SERVER_CORE_SESSION_HISTORY_MUTATION_METHODS = Object.freeze([
  'session.archive',
  'session.unarchive',
  'session.delete',
] as const satisfies readonly CoreMethod[]);

type HistoryMutationMethod = (typeof SERVER_CORE_SESSION_HISTORY_MUTATION_METHODS)[number];

export interface ServerCoreSessionHistoryMutationRuntimeOptions {
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly manager: Pick<ServerCoreSessionManager, 'archive' | 'delete' | 'unarchive'>;
  readonly teams: Pick<AgentDeckTeamRepo,
    | 'archive'
    | 'countActiveLeads'
    | 'findActiveMembershipsBySession'
    | 'get'
    | 'leaveTeam'
    | 'unarchive'>;
  readonly metadata: ServerCoreMutationLedgerPort & {
    currentRevision(): number;
    appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  };
}

function isHistoryMutation(method: CoreMethod): method is HistoryMutationMethod {
  return (SERVER_CORE_SESSION_HISTORY_MUTATION_METHODS as readonly CoreMethod[]).includes(method);
}

/** Desktop-only history lifecycle mutations with row-CAS and Core idempotency. */
export class ServerCoreSessionHistoryMutationRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreSessionHistoryMutationRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_SESSION_HISTORY_MUTATION_METHODS]),
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

  execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isHistoryMutation(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    return this.mutate(input);
  }

  private async mutate(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionHistoryMutationParams(input.params);
    const claim = claimServerCoreMutation(input, this.options.metadata);
    if (claim.replay) return claim.replay;
    let mutated = false;
    try {
      const record = this.options.sessions.get(params.sessionId);
      if (!record) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session was not found');
      }
      const archived = record.archivedAt !== null;
      const inHistory = record.lifecycle === 'closed' || archived;
      if (
        !inHistory || archived !== params.expectedArchived ||
        record.lastEventAt !== params.expectedUpdatedAt
      ) {
        throw new DaemonRequestError(
          AgentDeckClientErrorCode.Conflict,
          'History row changed; refresh before retrying',
        );
      }
      let state: SessionHistoryMutationState;
      if (input.method === 'session.archive') {
        if (archived) throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Session is archived');
        await this.options.manager.archive(record.id);
        mutated = true;
        this.archiveOrphanedLeadTeams(record.id);
        state = 'archived';
      } else if (input.method === 'session.unarchive') {
        if (!archived) throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Session is not archived');
        await this.options.manager.unarchive(record.id);
        mutated = true;
        this.restoreLeadTeams(record.id);
        state = 'unarchived';
      } else {
        this.leaveTeams(record.id);
        await this.options.manager.delete(record.id);
        mutated = true;
        state = 'deleted';
      }
      const revision = this.options.metadata.currentRevision();
      const result = parseSessionHistoryMutationResult({
        sessionId: record.id,
        state,
        revision,
      }, record.id, state);
      return completeServerCoreMutation(claim, this.options.metadata, result, revision);
    } catch (cause) {
      // Once the repository changed, retain the claim as uncertain; replaying could duplicate
      // provider/team side effects or turn a successful delete into a misleading not-found.
      if (mutated) throw cause;
      return releaseServerCoreMutation(claim, this.options.metadata, cause);
    }
  }

  private archiveOrphanedLeadTeams(sessionId: string): void {
    for (const membership of this.safeMemberships(sessionId)) {
      try {
        if (membership.role !== 'lead' || this.options.teams.countActiveLeads(membership.teamId) > 0) {
          continue;
        }
        const team = this.options.teams.archive(membership.teamId, { reason: 'last-lead-archived' });
        if (team) this.options.metadata.appendChange('team.archived', team.id, { teamId: team.id });
      } catch {
        // Session lifecycle is authoritative; Team projection repair remains best effort.
      }
    }
  }

  private restoreLeadTeams(sessionId: string): void {
    for (const membership of this.safeMemberships(sessionId)) {
      try {
        if (membership.role !== 'lead') continue;
        const team = this.options.teams.get(membership.teamId);
        if (!team || team.archiveReason !== 'last-lead-archived') continue;
        const restored = this.options.teams.unarchive(team.id);
        if (restored) {
          this.options.metadata.appendChange('team.unarchived', team.id, { teamId: team.id });
        }
      } catch {
        // Session lifecycle is authoritative; Team projection repair remains best effort.
      }
    }
  }

  private leaveTeams(sessionId: string): void {
    for (const membership of this.safeMemberships(sessionId)) {
      try {
        this.options.teams.leaveTeam(membership.teamId, sessionId);
        this.options.metadata.appendChange('team.member-left', membership.teamId, {
          sessionId,
          teamId: membership.teamId,
        });
        if (this.options.teams.countActiveLeads(membership.teamId) > 0) continue;
        const team = this.options.teams.archive(membership.teamId, { reason: 'last-lead-deleted' });
        if (team) this.options.metadata.appendChange('team.archived', team.id, { teamId: team.id });
      } catch {
        // Deletion must not be held hostage by a stale Team projection.
      }
    }
  }

  private safeMemberships(sessionId: string) {
    try { return this.options.teams.findActiveMembershipsBySession(sessionId); }
    catch { return []; }
  }
}
