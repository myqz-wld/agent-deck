import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { SessionRecord } from '@shared/types';

export interface ServerCoreSpawnTeamPreflight {
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly created: boolean;
}

export interface ServerCoreSpawnCollaborationOptions {
  readonly teams: AgentDeckTeamRepo;
  readonly messages: AgentDeckMessageRepo;
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly transaction: <T>(operation: () => T) => T;
  readonly notifyMembershipChanged: (sessionId: string) => void;
  readonly now?: () => number;
}

/** Owns the synchronous team + synthetic reply-anchor transaction after provider creation. */
export class ServerCoreSpawnCollaboration {
  private readonly now: () => number;

  constructor(private readonly options: ServerCoreSpawnCollaborationOptions) {
    this.now = options.now ?? Date.now;
  }

  preflight(callerSessionId: string, teamName: string | undefined): ServerCoreSpawnTeamPreflight {
    if (teamName === undefined) return { teamId: null, teamName: null, created: false };
    const existing = this.options.teams.getByActiveName(teamName);
    const team = this.options.teams.ensureByName(teamName, { source: 'server-core-mcp' });
    if (existing && existing.id !== team.id) {
      throw new Error('Team identity changed during spawn preflight');
    }
    const membership = this.options.teams.findActiveMembershipIn(team.id, callerSessionId);
    if (membership && membership.role !== 'lead') {
      throw new Error('Authenticated caller is not a lead in the requested team');
    }
    return { teamId: team.id, teamName, created: existing === null };
  }

  complete(input: {
    readonly preflight: ServerCoreSpawnTeamPreflight;
    readonly callerSessionId: string;
    readonly targetSessionId: string;
    readonly displayName: string | null;
    readonly anchorId: string;
    readonly anchorBody: string;
  }): void {
    this.options.transaction(() => {
      this.requireLive(input.callerSessionId, 'Caller');
      this.requireLive(input.targetSessionId, 'Target');
      const teamId = input.preflight.teamId;
      if (teamId !== null) {
        const caller = this.options.teams.findActiveMembershipIn(teamId, input.callerSessionId);
        if (caller && caller.role !== 'lead') {
          throw new Error('Authenticated caller lost team-lead authority');
        }
        if (!caller) {
          this.options.teams.addMember({
            teamId,
            sessionId: input.callerSessionId,
            role: 'lead',
          });
        }
        if (this.options.teams.findActiveMembershipIn(teamId, input.targetSessionId)) {
          throw new Error('Spawn target already belongs to the requested team');
        }
        this.options.teams.addMember({
          teamId,
          sessionId: input.targetSessionId,
          role: 'teammate',
          displayName: input.displayName,
        });
      }
      const inserted = this.options.messages.insert({
        id: input.anchorId,
        teamId,
        fromSessionId: input.callerSessionId,
        toSessionId: input.targetSessionId,
        body: input.anchorBody,
        replyToMessageId: null,
      });
      if (inserted.id !== input.anchorId) {
        throw new Error('Message repository changed the spawn reply anchor identity');
      }
      const delivered = this.options.messages.markDelivered(input.anchorId, this.now());
      if (!delivered || delivered.status !== 'delivered') {
        throw new Error('Spawn reply anchor was not durably delivered');
      }
    });
    if (input.preflight.teamId !== null) {
      this.options.notifyMembershipChanged(input.callerSessionId);
      this.options.notifyMembershipChanged(input.targetSessionId);
    }
  }

  cleanup(preflight: ServerCoreSpawnTeamPreflight): void {
    if (!preflight.created || preflight.teamId === null) return;
    const members = this.options.teams.listAllMembers(preflight.teamId);
    if (members.length === 0) this.options.teams.hardDelete(preflight.teamId);
  }

  private requireLive(sessionId: string, label: string): SessionRecord {
    const record = this.options.sessions.get(sessionId);
    if (!record || record.lifecycle === 'closed' || record.archivedAt !== null) {
      throw new Error(`${label} session is no longer live`);
    }
    return record;
  }
}
