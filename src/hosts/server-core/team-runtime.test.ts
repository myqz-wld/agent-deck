import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import { TEAM_MEMBER_MAX_ITEMS } from '@contracts/index';
import type {
  DaemonCoreRuntime,
  DaemonRequestInput,
  DaemonRequestResult,
} from '@hosts/daemon';
import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type {
  AgentDeckMessage,
  AgentDeckTeam,
  AgentDeckTeamMember,
  SessionRecord,
} from '@shared/types';
import { ServerCoreTeamRuntime } from './team-runtime';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'server-core', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', accessCredentialId: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop-full',
};

function session(id: string, agentId = 'codex-cli'): SessionRecord {
  return {
    id, agentId, cwd: `/workspaces/${id}`, title: id, source: 'sdk', lifecycle: 'active',
    activity: 'idle', startedAt: 1, lastEventAt: 2, endedAt: null, archivedAt: null,
  };
}

function request(
  method: CoreMethod,
  params: JsonObject,
  options: { mutation?: boolean; access?: AuthenticatedClientAccessContext } = {},
): DaemonRequestInput {
  return {
    access: options.access ?? desktop,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: options.mutation ? `intent-${method}` : null,
    expectedRevision: options.mutation ? 4 : null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness() {
  let revision = 4;
  let team: AgentDeckTeam = {
    id: 'team-a', name: 'Remote team', createdAt: 1, archivedAt: null,
    archiveReason: null, metadata: {},
  };
  const members: AgentDeckTeamMember[] = [
    { teamId: team.id, sessionId: 'lead-a', role: 'lead', displayName: null, joinedAt: 1, leftAt: null },
    { teamId: team.id, sessionId: 'mate-a', role: 'teammate', displayName: 'Mate', joinedAt: 1, leftAt: null },
  ];
  const sessions = new Map([
    ['lead-a', session('lead-a', 'claude-code')],
    ['mate-a', session('mate-a')],
    ['candidate-a', session('candidate-a', 'grok-build')],
  ]);
  const claims = new Map<string, {
    identity: ServerCoreMutationIdentity;
    result?: JsonValue;
    revision?: number;
  }>();
  const metadata = {
    currentRevision: () => revision,
    appendChange: vi.fn((_kind: string, _entityId: string | null, _payload: JsonValue) => ++revision),
    claimMutation: vi.fn((
      identity: ServerCoreMutationIdentity,
      _now?: number,
      expectedRevision?: number,
    ): ServerCoreMutationClaim => {
      const existing = claims.get(identity.idempotencyKey);
      if (existing) {
        if (existing.identity.requestFingerprint !== identity.requestFingerprint) return { state: 'conflict' };
        if (existing.result === undefined || existing.revision === undefined) return { state: 'uncertain' };
        return { state: 'completed', result: existing.result, revision: existing.revision };
      }
      if (expectedRevision !== revision) return { state: 'conflict' };
      claims.set(identity.idempotencyKey, { identity });
      return { state: 'claimed' };
    }),
    completeMutation: vi.fn((identity: ServerCoreMutationIdentity, result: JsonValue, resultRevision: number) => {
      const claim = claims.get(identity.idempotencyKey)!;
      claim.result = result;
      claim.revision = resultRevision;
    }),
    releaseMutationClaim: vi.fn((identity: ServerCoreMutationIdentity) => {
      if (!claims.delete(identity.idempotencyKey)) throw new Error('claim was not retained');
    }),
  };
  const archive = vi.fn(() => {
    team = { ...team, archivedAt: 10, archiveReason: 'user-action' };
    return team;
  });
  const addMember = vi.fn((input: {
    teamId: string; sessionId: string; role: 'lead' | 'teammate'; displayName?: string | null;
  }) => {
    const member: AgentDeckTeamMember = {
      ...input, displayName: input.displayName ?? null, joinedAt: 3, leftAt: null,
    };
    members.push(member);
    return member;
  });
  const teams = {
    get: (teamId: string) => teamId === team.id ? team : null,
    getWithMembers: (teamId: string) => teamId === team.id ? { ...team, members } : null,
    list: () => [team],
    archive,
    addMember,
    listActiveMembers: () => members.filter((member) => member.leftAt === null),
  } as unknown as AgentDeckTeamRepo;
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health', 'pending.list'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: () => revision,
    execute: vi.fn(async (input): Promise<DaemonRequestResult> => {
      if (input.method === 'pending.list') {
        return {
          result: {
            requests: input.params.sessionId === 'mate-a'
              ? [{ kind: 'permission' }, { kind: 'diff-review' }]
              : [],
            revision,
          },
          revision,
        };
      }
      return { result: { ok: true, revision }, revision };
    }),
  };
  const closeSession = vi.fn(async () => undefined);
  const notifyMembershipChanged = vi.fn();
  const messages: AgentDeckMessage[] = [{
    id: 'message-a', teamId: team.id, fromSessionId: 'lead-a', toSessionId: 'mate-a',
    body: 'Review this', status: 'delivered', statusReason: null, sentAt: 2,
    deliveredAt: 3, attemptCount: 1, lastAttemptAt: 2, deliveringSince: null,
    replyToMessageId: null, deliveryGeneration: 1, deliveryLeaseToSessionId: null,
  }];
  const runtime = new ServerCoreTeamRuntime(base, {
    workspaceRoot: '/workspaces',
    privateRoots: ['/state'],
    teams,
    messages: { listByTeam: () => messages } as Pick<AgentDeckMessageRepo, 'listByTeam'>,
    sessions: {
      get: (id) => sessions.get(id) ?? null,
      listActiveAndDormant: (limit, offset) => [...sessions.values()].slice(offset, offset + limit),
    },
    events: { findTeamEvents: () => [] },
    tasks: { list: () => [] },
    closeSession,
    notifyMembershipChanged,
    metadata,
  });
  return {
    addMember, archive, base, closeSession, members, metadata, notifyMembershipChanged, runtime,
  };
}

describe('ServerCoreTeamRuntime', () => {
  it('publishes desktop Team methods and returns the shared bounded detail model', async () => {
    const state = harness();
    expect(state.runtime.supportedMethods).toContain('teams.get');
    const response = await state.runtime.execute(request('teams.get', { teamId: 'team-a' }));
    expect(response).toMatchObject({ result: { team: { id: 'team-a' }, revision: 4 } });
    const result = response.result as unknown as {
      team: {
        sessions: Array<{ id: string; adapterId: string }>;
        pending: Array<{ sessionId: string; permissions: number; diffs: number; total: number }>;
        recentMessages: Array<{ body: string }>;
      };
    };
    expect(result.team.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'candidate-a', adapterId: 'grok-build' }),
    ]));
    expect(result.team.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'mate-a', permissions: 1, diffs: 1, total: 2 }),
    ]));
    expect(result.team.recentMessages).toEqual([
      expect.objectContaining({ body: 'Review this' }),
    ]);
  });

  it('replays one revision-bound archive and denies the Feishu surface', async () => {
    const state = harness();
    const input = request('teams.archive', { teamId: 'team-a' }, { mutation: true });
    const first = await state.runtime.execute(input);
    await expect(state.runtime.execute({ ...input, requestId: 'request-replay' })).resolves.toEqual(first);
    expect(state.archive).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ result: { team: { archivedAt: 10 }, revision: 5 }, revision: 5 });

    const feishu = {
      ...desktop, clientId: 'feishu-a', transport: 'feishu' as const,
      surface: 'feishu-session-console' as const,
    };
    await expect(state.runtime.execute(request('teams.get', { teamId: 'team-a' }, {
      access: feishu,
    }))).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('adds a compatible member and shuts down teammates without closing the lead', async () => {
    const added = harness();
    await expect(added.runtime.execute(request('teams.add-member', {
      teamId: 'team-a', sessionId: 'candidate-a', role: 'teammate',
    }, { mutation: true }))).resolves.toMatchObject({
      result: { member: { sessionId: 'candidate-a', role: 'teammate' }, revision: 5 },
    });
    expect(added.notifyMembershipChanged).toHaveBeenCalledWith('candidate-a');

    const shutdown = harness();
    await expect(shutdown.runtime.execute(request(
      'teams.shutdown-teammates',
      { teamId: 'team-a' },
      { mutation: true },
    ))).resolves.toMatchObject({ result: { closed: ['mate-a'], failed: [], revision: 5 } });
    expect(shutdown.closeSession).toHaveBeenCalledTimes(1);
    expect(shutdown.closeSession).toHaveBeenCalledWith('mate-a');
  });

  it('replays a completed add-member after later Team state changes', async () => {
    const state = harness();
    const input = request('teams.add-member', {
      teamId: 'team-a', sessionId: 'candidate-a', role: 'teammate',
    }, { mutation: true });
    const first = await state.runtime.execute(input);
    state.archive();

    await expect(state.runtime.execute({ ...input, requestId: 'request-add-replay' }))
      .resolves.toEqual(first);
    expect(state.addMember).toHaveBeenCalledOnce();
  });

  it('rejects oversized Team reads before issuing per-member pending requests', async () => {
    const state = harness();
    for (let index = state.members.length; index <= TEAM_MEMBER_MAX_ITEMS; index += 1) {
      state.members.push({
        teamId: 'team-a', sessionId: `past-${index}`, role: 'teammate', displayName: null,
        joinedAt: 1, leftAt: 2,
      });
    }

    await expect(state.runtime.execute(request('teams.get', { teamId: 'team-a' })))
      .rejects.toMatchObject({ code: 'internal_error' });
    expect(state.base.execute).not.toHaveBeenCalled();
  });

  it('rejects a new member when the bounded Remote Team surface is full', async () => {
    const state = harness();
    for (let index = state.members.length; index < TEAM_MEMBER_MAX_ITEMS; index += 1) {
      state.members.push({
        teamId: 'team-a', sessionId: `past-${index}`, role: 'teammate', displayName: null,
        joinedAt: 1, leftAt: 2,
      });
    }

    await expect(state.runtime.execute(request('teams.add-member', {
      teamId: 'team-a', sessionId: 'candidate-a', role: 'teammate',
    }, { mutation: true }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(state.addMember).not.toHaveBeenCalled();
    expect(state.metadata.claimMutation).toHaveBeenCalledOnce();
    expect(state.metadata.releaseMutationClaim).toHaveBeenCalledOnce();

    state.members.splice(TEAM_MEMBER_MAX_ITEMS - 1);
    await expect(state.runtime.execute(request('teams.add-member', {
      teamId: 'team-a', sessionId: 'candidate-a', role: 'teammate',
    }, { mutation: true }))).resolves.toMatchObject({
      result: { member: { sessionId: 'candidate-a' } },
    });
  });
});
