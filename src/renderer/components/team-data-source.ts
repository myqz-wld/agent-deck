import { useMemo, useRef, useSyncExternalStore, type MutableRefObject } from 'react';

import type {
  TeamAddMemberResult,
  TeamDetailDto,
  TeamGetResult,
  TeamListResult,
  TeamMemberRoleDto,
  TeamMutationResult,
  TeamPendingCountsDto,
  TeamShutdownResult,
} from '@contracts/index';
import { isJsonValue } from '@contracts/index';
import { selectPendingBuckets } from '@renderer/lib/session-selectors';
import { useSessionStore } from '@renderer/stores/session-store';
import type { AgentDeckMessage, AgentEvent, SessionRecord, TaskRecord } from '@shared/types';
import { RemoteUserIntentLedger } from '../remote-host/remote-intent-ledger';
import { remoteMutationAuthority } from '../remote-host/remote-source-utils';
import type { RemoteSessionSourceView } from '../remote-host/source-types';

export interface TeamDataSource {
  identity: string;
  readonly revision: number;
  isUsable(): boolean;
  list(): Promise<TeamListResult>;
  get(teamId: string): Promise<TeamGetResult>;
  archive(teamId: string, expectedRevision: number): Promise<TeamMutationResult>;
  addMember(
    teamId: string,
    sessionId: string,
    role: TeamMemberRoleDto,
    expectedRevision: number,
  ): Promise<TeamAddMemberResult>;
  shutdownTeammates(teamId: string, expectedRevision: number): Promise<TeamShutdownResult>;
  subscribe(listener: () => void, teamId?: string): () => void;
}

const EMPTY_LOCAL_STATE = Object.freeze({
  sessions: new Map(),
  pendingPermissionsBySession: new Map(),
  pendingAskQuestionsBySession: new Map(),
  pendingExitPlanModesBySession: new Map(),
  pendingDiffReviewsBySession: new Map(),
});
const noSubscribe = (): (() => void) => () => undefined;
const emptyLocalState = () => EMPTY_LOCAL_STATE;

export function useTeamDataSource(
  remote: RemoteSessionSourceView | null,
  localEnabled = remote === null,
): TeamDataSource {
  const localState = useSyncExternalStore(
    localEnabled ? useSessionStore.subscribe : noSubscribe,
    localEnabled ? useSessionStore.getState : emptyLocalState,
    emptyLocalState,
  );
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const intents = useRef(new RemoteUserIntentLedger());

  return useMemo(() => {
    if (remote) return remoteSource(remote.identity, remoteRef, intents.current);
    const pending = new Map(selectPendingBuckets(
      localState.sessions,
      localState.pendingPermissionsBySession,
      localState.pendingAskQuestionsBySession,
      localState.pendingExitPlanModesBySession,
      localState.pendingDiffReviewsBySession,
    ).map((bucket) => [bucket.session.id, {
      sessionId: bucket.session.id,
      permissions: bucket.permissions.length,
      questions: bucket.askQuestions.length,
      plans: bucket.exitPlanModes.length,
      diffs: bucket.diffReviews.length,
      total: bucket.total,
    } satisfies TeamPendingCountsDto]));
    return localSource(localState.sessions, pending);
  }, [
    localState, remote?.identity,
  ]);
}

function remoteSource(
  identity: string,
  remoteRef: MutableRefObject<RemoteSessionSourceView | null>,
  intents: RemoteUserIntentLedger,
): TeamDataSource {
  const requireProfile = (): string => {
    const current = remoteRef.current;
    if (!current || current.identity !== identity || !current.profile?.id || !current.usable) {
      throw new Error('远程团队数据源尚未连接。');
    }
    return current.profile.id;
  };
  const mutate = <T>(
    operation: string,
    payload: { teamId: string; expectedRevision: number },
    request: (
      intentId: string,
      profileId: string,
      expectedAuthority: ReturnType<typeof remoteMutationAuthority>,
    ) => Promise<T>,
  ): Promise<T> => intents.run(identity, operation, payload, (intentId) => {
    const profileId = requireProfile();
    return request(
      intentId,
      profileId,
      remoteMutationAuthority(remoteRef.current?.state ?? null),
    );
  });
  return {
    identity,
    get revision() { return remoteRef.current?.resourceRevisions.teams ?? 0; },
    isUsable: () => {
      const current = remoteRef.current;
      return current?.identity === identity && current.usable;
    },
    list: async () => window.api.listRemoteHostTeams({
      profileId: requireProfile(),
      includeArchived: false,
      limit: 200,
    }),
    get: async (teamId) => window.api.getRemoteHostTeam({
      profileId: requireProfile(),
      teamId,
    }),
    archive: (teamId, expectedRevision) => mutate(
      'team-archive',
      { teamId, expectedRevision },
      (intentId, currentProfileId, expectedAuthority) => window.api.archiveRemoteHostTeam({
        profileId: currentProfileId,
        teamId,
        expectedAuthority,
        expectedRevision,
        intentId,
      }),
    ),
    addMember: (teamId, sessionId, role, expectedRevision) => intents.run(
      identity,
      'team-add-member',
      { teamId, sessionId, role, expectedRevision },
      (intentId) => {
        const profileId = requireProfile();
        return window.api.addRemoteHostTeamMember({
          profileId,
          teamId,
          sessionId,
          role,
          expectedAuthority: remoteMutationAuthority(remoteRef.current?.state ?? null),
          expectedRevision,
          intentId,
        });
      },
    ),
    shutdownTeammates: (teamId, expectedRevision) => mutate(
      'team-shutdown-teammates',
      { teamId, expectedRevision },
      (intentId, currentProfileId, expectedAuthority) =>
        window.api.shutdownRemoteHostTeamTeammates({
          profileId: currentProfileId,
          teamId,
          expectedAuthority,
          expectedRevision,
          intentId,
        }),
    ),
    subscribe: () => () => undefined,
  };
}

function localSource(
  sessions: ReadonlyMap<string, SessionRecord>,
  pending: ReadonlyMap<string, TeamPendingCountsDto>,
): TeamDataSource {
  return {
    identity: 'local',
    revision: 0,
    isUsable: () => true,
    list: async () => ({
      teams: (await window.api.listAgentDeckTeams({ includeArchived: false })).map((team) => {
        const members = team.members ?? [];
        return {
          id: team.id,
          name: team.name,
          createdAt: team.createdAt,
          archivedAt: team.archivedAt,
          memberCount: members.length,
          lastEventAt: members.reduce((latest, member) =>
            Math.max(latest, sessions.get(member.sessionId)?.lastEventAt ?? team.createdAt),
          team.createdAt),
        };
      }),
      revision: 0,
    }),
    get: async (teamId) => {
      const row = await window.api.getAgentDeckTeamFull(teamId);
      return { team: row ? localDetail(row, sessions, pending) : null, revision: 0 };
    },
    archive: async (teamId) => {
      const team = await window.api.archiveAgentDeckTeam(teamId);
      return {
        team: team ? {
          id: team.id,
          name: team.name,
          createdAt: team.createdAt,
          archivedAt: team.archivedAt,
          memberCount: team.members?.length ?? 0,
          lastEventAt: team.createdAt,
        } : null,
        revision: 0,
      };
    },
    addMember: async (teamId, sessionId, role) => ({
      member: await window.api.addAgentDeckTeamMember({ teamId, sessionId, role }),
      revision: 0,
    }),
    shutdownTeammates: async (teamId) => ({
      ...await window.api.shutdownAllTeammates(teamId),
      revision: 0,
    }),
    subscribe: (listener, teamId) => {
      const offTeam = window.api.onAgentDeckTeamChanged((items) => {
        if (!teamId || items.some((item) => item.teamId === teamId)) listener();
      });
      const offMessage = window.api.onAgentDeckMessageChanged((items) => {
        if (!teamId || items.some((item) => item.teamId === teamId)) listener();
      });
      return () => { offTeam(); offMessage(); };
    },
  };
}

function localDetail(
  row: {
    id: string;
    name: string;
    createdAt: number;
    archivedAt: number | null;
    archiveReason: TeamDetailDto['archiveReason'];
    members: TeamDetailDto['members'];
    recentEvents: (AgentEvent & { id: number })[];
    tasks: TaskRecord[];
    recentMessages: AgentDeckMessage[];
  },
  sessions: ReadonlyMap<string, SessionRecord>,
  pending: ReadonlyMap<string, TeamPendingCountsDto>,
): TeamDetailDto {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    members: row.members,
    sessions: [...sessions.values()].map((session) => ({
      id: session.id,
      adapterId: session.agentId,
      title: session.title,
      lifecycle: session.lifecycle,
      lastEventAt: session.lastEventAt,
      archivedAt: session.archivedAt,
      spawnedBy: session.spawnedBy ?? null,
    })),
    pending: row.members.flatMap((member) => {
      const counts = pending.get(member.sessionId);
      return counts ? [counts] : [];
    }),
    recentEvents: row.recentEvents.flatMap((event) => isJsonValue(event.payload)
      ? [{
          id: event.id,
          sessionId: event.sessionId,
          agentId: event.agentId,
          kind: event.kind,
          payload: event.payload,
          ts: event.ts,
        }]
      : []),
    tasks: row.tasks,
    recentMessages: row.recentMessages.map((message) => ({
      id: message.id,
      fromSessionId: message.fromSessionId,
      toSessionId: message.toSessionId,
      body: message.body,
      status: message.status,
      statusReason: message.statusReason,
      sentAt: message.sentAt,
      replyToMessageId: message.replyToMessageId,
    })),
  };
}
