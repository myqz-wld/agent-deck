import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSessionOptions, ForkSessionSource } from '@main/adapters/types';
import type { AgentDeckMessage, SessionRecord } from '@shared/types';

const state = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  teams: new Map<string, { id: string; name: string }>(),
  members: new Map<string, Map<string, { role: 'lead' | 'teammate' }>>(),
  messages: new Map<string, AgentDeckMessage>(),
  createCalls: [] as CreateSessionOptions[],
  forkCalls: [] as Array<{ source: ForkSessionSource; target: CreateSessionOptions }>,
  order: [] as string[],
  guardCalls: 0,
  guardReleases: 0,
  nextChild: 1,
  ensureError: null as Error | null,
  listError: null as Error | null,
  insertError: null as Error | null,
  markError: null as Error | null,
  markReturnsNull: false,
  strictCloseError: null as Error | null,
  closeError: null as Error | null,
  clearLinkError: null as Error | null,
  discardError: null as Error | null,
}));

function teamMembers(teamId: string): Map<string, { role: 'lead' | 'teammate' }> {
  let members = state.members.get(teamId);
  if (!members) {
    members = new Map();
    state.members.set(teamId, members);
  }
  return members;
}

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sid: string) => state.sessions.get(sid) ?? null,
    setSpawnLink: (sid: string, parent: string | null, depth: number) => {
      state.order.push(parent === null ? `link:clear:${sid}` : `link:set:${sid}`);
      if (parent === null && state.clearLinkError) throw state.clearLinkError;
      const record = state.sessions.get(sid);
      if (record) {
        state.sessions.set(sid, { ...record, spawnedBy: parent, spawnDepth: depth });
      }
    },
    setTitle: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    recordCreatedPermissionMode: vi.fn(),
    notifyTeamMembershipChanged: vi.fn(),
    close: async (sid: string) => {
      state.order.push(`close:${sid}`);
      if (state.closeError) throw state.closeError;
      const record = state.sessions.get(sid);
      if (record) state.sessions.set(sid, { ...record, lifecycle: 'closed' });
    },
  },
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  TeamInvariantError: class TeamInvariantError extends Error {},
  agentDeckTeamRepo: {
    getByActiveName: (name: string) =>
      [...state.teams.values()].find((team) => team.name === name) ?? null,
    ensureByName: (name: string) => {
      state.order.push(`team:ensure:${name}`);
      if (state.ensureError) throw state.ensureError;
      const existing = [...state.teams.values()].find((team) => team.name === name);
      if (existing) return existing;
      const team = { id: `team-${name}`, name };
      state.teams.set(team.id, team);
      teamMembers(team.id);
      return team;
    },
    listAllMembers: (teamId: string) => {
      state.order.push(`team:list:${teamId}`);
      if (state.listError) throw state.listError;
      return [...teamMembers(teamId).entries()].map(([sessionId, member]) => ({
        teamId,
        sessionId,
        role: member.role,
        displayName: null,
        joinedAt: 1,
        leftAt: null,
      }));
    },
    findActiveMembershipIn: (teamId: string, sid: string) => {
      const member = teamMembers(teamId).get(sid);
      return member
        ? {
            teamId,
            sessionId: sid,
            role: member.role,
            displayName: null,
            joinedAt: 1,
            leftAt: null,
          }
        : null;
    },
    addMember: (input: {
      teamId: string;
      sessionId: string;
      role: 'lead' | 'teammate';
    }) => {
      state.order.push(`team:add:${input.sessionId}`);
      const members = teamMembers(input.teamId);
      if (members.has(input.sessionId)) {
        const error = new Error(`member ${input.sessionId} already active`);
        error.name = 'TeamInvariantError';
        throw error;
      }
      members.set(input.sessionId, { role: input.role });
      return {
        ...input,
        displayName: null,
        joinedAt: 1,
        leftAt: null,
      };
    },
    leaveTeam: (teamId: string, sid: string) => {
      state.order.push(`team:leave:${sid}`);
      const member = teamMembers(teamId).get(sid);
      teamMembers(teamId).delete(sid);
      return member
        ? {
            teamId,
            sessionId: sid,
            role: member.role,
            displayName: null,
            joinedAt: 1,
            leftAt: 2,
          }
        : null;
    },
    hardDelete: (teamId: string) => {
      state.order.push(`team:delete:${teamId}`);
      if (teamMembers(teamId).size > 0) return false;
      state.members.delete(teamId);
      return state.teams.delete(teamId);
    },
  },
}));

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    insert: (input: {
      id: string;
      teamId: string | null;
      fromSessionId: string;
      toSessionId: string;
      body: string;
      replyToMessageId: null;
    }) => {
      state.order.push(`anchor:insert:${input.id}`);
      if (state.insertError) throw state.insertError;
      const message: AgentDeckMessage = {
        ...input,
        status: 'pending',
        statusReason: null,
        sentAt: 1,
        deliveredAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        deliveringSince: null,
        deliveryGeneration: 0,
        deliveryLeaseToSessionId: null,
      };
      state.messages.set(message.id, message);
      return message;
    },
    get: (id: string) => state.messages.get(id) ?? null,
    markDelivered: (id: string, now: number) => {
      state.order.push(`anchor:mark:${id}`);
      if (state.markError) throw state.markError;
      if (state.markReturnsNull) return null;
      const message = state.messages.get(id);
      if (!message) return null;
      const delivered = { ...message, status: 'delivered' as const, deliveredAt: now };
      state.messages.set(id, delivered);
      return delivered;
    },
    cancel: (id: string, reason: string) => {
      state.order.push(`anchor:cancel:${id}`);
      const message = state.messages.get(id);
      if (!message || !['pending', 'delivering'].includes(message.status)) return null;
      const cancelled = { ...message, status: 'cancelled' as const, statusReason: reason };
      state.messages.set(id, cancelled);
      return cancelled;
    },
    batchHardDelete: (ids: readonly string[]) => {
      const removed: string[] = [];
      for (const id of ids) {
        state.order.push(`anchor:delete:${id}`);
        const message = state.messages.get(id);
        if (message && ['delivered', 'failed', 'cancelled'].includes(message.status)) {
          state.messages.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },
  },
}));

function registerChild(target: CreateSessionOptions): string {
  const sid = `child-${state.nextChild++}`;
  state.sessions.set(sid, {
    id: sid,
    agentId: target.agentId,
    cwd: target.cwd,
    title: 'child',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 2,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    cliSessionId: `native-${sid}`,
    spawnedBy: target.initialSessionRegistration?.spawnLink.parentSessionId ?? null,
    spawnDepth: target.initialSessionRegistration?.spawnLink.depth ?? 0,
  });
  target.initialSessionRegistration?.onRegistered(sid);
  return sid;
}

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      if (id !== 'codex-cli') return undefined;
      return {
        id,
        capabilities: {
          canCreateSession: true,
          canForkSession: true,
          canSetPermissionMode: false,
        },
        createSession: async (target: CreateSessionOptions) => {
          state.createCalls.push({ ...target } as CreateSessionOptions);
          return registerChild(target);
        },
        closeSessionForRollback: async (sid: string) => {
          state.order.push(`strict-close:${sid}`);
          if (state.strictCloseError) throw state.strictCloseError;
        },
        validateForkSession: vi.fn(async () => undefined),
        createForkedSession: async (source: ForkSessionSource, target: CreateSessionOptions) => {
          state.forkCalls.push({ source: { ...source }, target: { ...target } as CreateSessionOptions });
          const sid = registerChild(target);
          return {
            sessionId: sid,
            discard: async () => {
              state.order.push(`fork:discard:${sid}`);
              if (state.discardError) throw state.discardError;
              state.sessions.delete(sid);
            },
          };
        },
      };
    },
  },
}));

vi.mock('../spawn-guards', () => ({
  applySpawnGuards: () => {
    state.guardCalls += 1;
    let released = false;
    return {
      ok: true,
      parentDepth: 0,
      spawnLimits: {
        depth: { current: 0, next: 1, max: 3 },
        fanOut: { current: 1, activeChildren: 0, inFlight: 1, max: 10 },
        rate: { current: 1, max: 20, windowMs: 60_000, retryAfterMs: 0 },
      },
      fanOutSlot: {
        release: () => {
          if (released) return;
          released = true;
          state.guardReleases += 1;
          state.order.push('guard:release');
        },
      },
    };
  },
}));

vi.mock('../tools/handlers/spawn-limits', () => ({
  finalizeSpawnLimits: (limits: unknown) => limits,
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../tools/handlers/spawn-agent-resolver', () => ({
  resolveSpawnAgent: () => {
    throw new Error('unexpected agent resolution');
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { spawnSessionHandler } from '../tools/handlers/spawn';

function seedCaller(): void {
  state.sessions.set('caller', {
    id: 'caller',
    agentId: 'codex-cli',
    cwd: process.cwd(),
    title: 'lead',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    cliSessionId: 'native-caller',
    spawnedBy: null,
    spawnDepth: 0,
  });
}

async function spawn(contextMode: 'fresh' | 'fork' = 'fresh') {
  const result = await spawnSessionHandler(
    {
      adapter: 'codex-cli',
      cwd: process.cwd(),
      prompt: 'delegated task',
      teamName: 'quality',
      contextMode,
    },
    {
      caller: {
        callerSessionId: 'caller',
        parentSessionId: 'caller',
        transport: 'in-process',
      },
    },
  );
  return {
    result,
    data: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

beforeEach(() => {
  state.sessions.clear();
  state.teams.clear();
  state.members.clear();
  state.messages.clear();
  state.createCalls.length = 0;
  state.forkCalls.length = 0;
  state.order.length = 0;
  state.guardCalls = 0;
  state.guardReleases = 0;
  state.nextChild = 1;
  state.ensureError = null;
  state.listError = null;
  state.insertError = null;
  state.markError = null;
  state.markReturnsNull = false;
  state.strictCloseError = null;
  state.closeError = null;
  state.clearLinkError = null;
  state.discardError = null;
  seedCaller();
});

describe('spawn_session collaboration transaction', () => {
  it('fails team ensure preflight before guard or provider creation', async () => {
    state.ensureError = new Error('team write unavailable');

    const { result, data } = await spawn();

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ phase: 'team-preflight', retryValid: true });
    expect(state.guardCalls).toBe(0);
    expect(state.createCalls).toHaveLength(0);
    expect(state.forkCalls).toHaveLength(0);
  });

  it('fails team membership-list preflight before provider creation and removes a new empty team', async () => {
    state.listError = new Error('team membership read unavailable');

    const { result, data } = await spawn();

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ phase: 'team-preflight', retryValid: true });
    expect(state.guardCalls).toBe(0);
    expect(state.createCalls).toHaveLength(0);
    expect(state.teams.size).toBe(0);
  });

  it('returns a non-null requested team and a durable anchor with prompt UUID identity', async () => {
    const { result, data } = await spawn();

    expect(result.isError).toBeUndefined();
    expect(data.teamId).toBe('team-quality');
    expect(data.spawnPromptMessageId).toEqual(expect.any(String));
    const anchorId = data.spawnPromptMessageId as string;
    expect(state.messages.get(anchorId)?.status).toBe('delivered');
    expect(state.createCalls[0]?.prompt).toContain(`[msg ${anchorId}]`);
    expect(state.teams.get('team-quality')).toBeTruthy();
  });

  it('reuses an existing team and preserves its lead while rolling back only the failed target', async () => {
    state.teams.set('team-quality', { id: 'team-quality', name: 'quality' });
    teamMembers('team-quality').set('caller', { role: 'lead' });
    state.insertError = new Error('anchor insert failed');

    const { result } = await spawn();

    expect(result.isError).toBe(true);
    expect([...teamMembers('team-quality').entries()]).toEqual([
      ['caller', { role: 'lead' }],
    ]);
    expect(state.teams.has('team-quality')).toBe(true);
  });

  it.each([
    ['insert', () => { state.insertError = new Error('anchor insert failed'); }],
    ['mark', () => { state.markError = new Error('anchor mark failed'); }],
    ['mark-null', () => { state.markReturnsNull = true; }],
  ] as const)('rolls back fresh creation when anchor %s fails', async (_label, inject) => {
    inject();

    const { result, data } = await spawn('fresh');

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({
      phase: expect.stringMatching(/^anchor-/),
      targetSessionId: 'child-1',
      retryValid: true,
    });
    expect(state.order.indexOf('strict-close:child-1'))
      .toBeLessThan(state.order.indexOf('close:child-1'));
    expect(state.sessions.get('child-1')?.lifecycle).toBe('closed');
    expect(state.sessions.get('child-1')?.spawnedBy).toBeNull();
    expect(teamMembers('team-quality').size).toBe(0);
    expect(state.teams.size).toBe(0);
    expect(state.messages.size).toBe(0);
    expect(state.guardReleases).toBe(1);
  });

  it('closes first, then removes anchor, link, memberships, and the empty team', async () => {
    state.markError = new Error('anchor mark failed');

    await spawn();

    const strictClose = state.order.indexOf('strict-close:child-1');
    const close = state.order.indexOf('close:child-1');
    const anchorDelete = state.order.findIndex((entry) => entry.startsWith('anchor:delete:'));
    const linkClear = state.order.indexOf('link:clear:child-1');
    const targetLeave = state.order.indexOf('team:leave:child-1');
    const callerLeave = state.order.indexOf('team:leave:caller');
    const teamDelete = state.order.indexOf('team:delete:team-quality');
    expect(strictClose).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(strictClose);
    expect(anchorDelete).toBeGreaterThan(close);
    expect(linkClear).toBeGreaterThan(anchorDelete);
    expect(targetLeave).toBeGreaterThan(linkClear);
    expect(callerLeave).toBeGreaterThan(targetLeave);
    expect(teamDelete).toBeGreaterThan(callerLeave);
  });

  it('discards a failed native fork only after closing and collaboration cleanup', async () => {
    state.insertError = new Error('anchor insert failed');

    const { result } = await spawn('fork');

    expect(result.isError).toBe(true);
    const close = state.order.indexOf('close:child-1');
    const teamDelete = state.order.indexOf('team:delete:team-quality');
    const discard = state.order.indexOf('fork:discard:child-1');
    expect(close).toBeGreaterThan(-1);
    expect(teamDelete).toBeGreaterThan(close);
    expect(discard).toBeGreaterThan(teamDelete);
    expect(state.sessions.has('child-1')).toBe(false);
  });

  it('reports strict provider close failure with truthful residuals and exact next action', async () => {
    state.insertError = new Error('anchor insert failed');
    state.strictCloseError = new Error('provider close failed');

    const { result, data } = await spawn();

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({
      targetSessionId: 'child-1',
      phase: 'anchor-insert',
      retryValid: false,
      residualState: expect.arrayContaining([
        'target-close-unverified',
        'target-active-or-unknown',
      ]),
      nextAction: expect.stringContaining('child-1'),
    });
    expect(String(data.nextAction)).toContain('Do not retry');
    expect(state.sessions.get('child-1')?.spawnedBy).toBeNull();
    expect(teamMembers('team-quality').size).toBe(0);
  });

  it('reports durable lifecycle close failure after strict provider shutdown', async () => {
    state.insertError = new Error('anchor insert failed');
    state.closeError = new Error('durable lifecycle close failed');

    const { result, data } = await spawn();

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({
      retryValid: false,
      residualState: expect.arrayContaining(['target-close-unverified']),
    });
    expect(state.order).toContain('strict-close:child-1');
  });

  it('reports strict fork discard residuals after collaboration cleanup', async () => {
    state.insertError = new Error('anchor insert failed');
    state.discardError = new Error('native delete failed');

    const { result, data } = await spawn('fork');

    expect(result.isError).toBe(true);
    expect(data).toMatchObject({
      retryValid: false,
      residualState: expect.arrayContaining(['native-fork-artifacts']),
      rollback: expect.objectContaining({ fork: 'failed' }),
    });
    expect(state.order.indexOf('team:delete:team-quality'))
      .toBeLessThan(state.order.indexOf('fork:discard:child-1'));
  });
});
