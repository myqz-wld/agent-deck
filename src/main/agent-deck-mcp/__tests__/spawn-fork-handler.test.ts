import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateSessionOptions,
  ForkSessionSource,
} from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

const state = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  createCalls: [] as CreateSessionOptions[],
  validateCalls: [] as Array<{ source: ForkSessionSource; target: CreateSessionOptions }>,
  forkCalls: [] as Array<{ source: ForkSessionSource; target: CreateSessionOptions }>,
  discardCalls: [] as string[],
  guardCalls: 0,
  guardReleases: 0,
  ensureTeamCalls: [] as Array<string | undefined>,
  membershipCalls: [] as string[],
  cleanupCalls: [] as string[],
  linkCalls: [] as Array<{ sid: string; parent: string; depth: number }>,
  placeholders: [] as Array<{ id: string; teamId: string | null; fromSessionId: string; toSessionId: string; body: string }>,
  order: [] as string[],
  nextChild: 1,
  validateThrow: null as Error | null,
  forkThrow: null as Error | null,
  teamFailure: false,
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sid: string) => state.sessions.get(sid) ?? null,
    setSpawnLink: (sid: string, parent: string, depth: number) => {
      state.linkCalls.push({ sid, parent, depth });
      const child = state.sessions.get(sid);
      if (child) state.sessions.set(sid, { ...child, spawnedBy: parent, spawnDepth: depth });
    },
    setTitle: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    recordCreatedPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    insert: (input: typeof state.placeholders[number]) => {
      state.placeholders.push(input);
      return { ...input };
    },
    markDelivered: vi.fn(),
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
    startedAt: 10,
    lastEventAt: 10,
    endedAt: null,
    archivedAt: null,
    cliSessionId: `native-${sid}`,
    spawnedBy: null,
    spawnDepth: 0,
  });
  return sid;
}

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      if (!['claude-code', 'deepseek-claude-code', 'codex-cli'].includes(id)) return undefined;
      return {
        id,
        capabilities: {
          canCreateSession: true,
          canForkSession: true,
          canSetPermissionMode: id !== 'codex-cli',
        },
        createSession: async (target: CreateSessionOptions) => {
          state.createCalls.push({ ...target } as CreateSessionOptions);
          return registerChild(target);
        },
        validateForkSession: async (source: ForkSessionSource, target: CreateSessionOptions) => {
          state.validateCalls.push({ source: { ...source }, target: { ...target } as CreateSessionOptions });
          if (state.validateThrow) throw state.validateThrow;
        },
        createForkedSession: async (source: ForkSessionSource, target: CreateSessionOptions) => {
          if (state.forkThrow) throw state.forkThrow;
          state.forkCalls.push({ source: { ...source }, target: { ...target } as CreateSessionOptions });
          const sid = registerChild(target);
          let discarded = false;
          return {
            sessionId: sid,
            discard: async () => {
              if (discarded) return;
              discarded = true;
              state.discardCalls.push(sid);
              state.order.push(`discard:${sid}`);
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
        },
      },
    };
  },
}));

vi.mock('../tools/handlers/spawn-team', () => ({
  ensureSpawnTeam: (teamName: string | undefined) => {
    state.ensureTeamCalls.push(teamName);
    return {
      teamIdEarly: teamName ? `team-${teamName}` : null,
      teamCreatedNow: Boolean(teamName),
    };
  },
  cleanupEmptySpawnTeam: (input: { failureLabel: string }) => {
    state.cleanupCalls.push(input.failureLabel);
  },
  completeSpawnTeamMembership: async (input: { sid: string; teamIdEarly: string | null }) => {
    state.membershipCalls.push(input.sid);
    if (state.teamFailure) {
      state.order.push(`close:${input.sid}`);
      state.sessions.delete(input.sid);
      return {
        ok: false,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'team setup failed', hint: 'retry' }) }],
        },
      };
    }
    return { ok: true, teamId: input.teamIdEarly };
  },
}));

vi.mock('../tools/handlers/spawn-limits', () => ({
  finalizeSpawnLimits: (limits: unknown) => limits,
}));

vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/store/agent-deck-team-repo', () => ({ agentDeckTeamRepo: {} }));
vi.mock('../tools/handlers/spawn-agent-resolver', () => ({
  resolveSpawnAgent: () => { throw new Error('unexpected agent resolution'); },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { spawnSessionHandler } from '../tools/handlers/spawn';

const adapters = ['claude-code', 'deepseek-claude-code', 'codex-cli'] as const;
type AdapterId = typeof adapters[number];

function seedCaller(adapter: AdapterId, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const record: SessionRecord = {
    id: 'caller',
    agentId: adapter,
    cwd: process.cwd(),
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    cliSessionId: `native-${adapter}`,
    spawnedBy: null,
    spawnDepth: 0,
    ...overrides,
  };
  state.sessions.set(record.id, record);
  return record;
}

function args(adapter: AdapterId, mode?: 'fresh' | 'fork', teamName?: string) {
  return {
    adapter,
    cwd: process.cwd(),
    prompt: 'delegated task',
    ...(mode ? { contextMode: mode } : {}),
    ...(teamName ? { teamName } : {}),
  };
}

async function call(adapter: AdapterId, mode?: 'fresh' | 'fork', teamName?: string, handOffMode = false) {
  const result = await spawnSessionHandler(
    args(adapter, mode, teamName),
    { caller: { callerSessionId: 'caller', parentSessionId: 'caller', transport: 'in-process' } },
    handOffMode ? { handOffMode: true } : undefined,
  );
  return {
    raw: result,
    data: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

beforeEach(() => {
  state.sessions.clear();
  state.createCalls.length = 0;
  state.validateCalls.length = 0;
  state.forkCalls.length = 0;
  state.discardCalls.length = 0;
  state.guardCalls = 0;
  state.guardReleases = 0;
  state.ensureTeamCalls.length = 0;
  state.membershipCalls.length = 0;
  state.cleanupCalls.length = 0;
  state.linkCalls.length = 0;
  state.placeholders.length = 0;
  state.order.length = 0;
  state.nextChild = 1;
  state.validateThrow = null;
  state.forkThrow = null;
  state.teamFailure = false;
});

describe('spawn_session native-fork handler lifecycle', () => {
  it.each(adapters)('forks the authenticated %s caller and preserves its row', async (adapter) => {
    const source = seedCaller(adapter);
    const before = structuredClone(source);
    const { raw, data } = await call(adapter, 'fork');

    expect(raw.isError).toBeUndefined();
    expect(data).toMatchObject({ contextMode: 'fork', forkedFromSessionId: 'caller' });
    expect(data).not.toHaveProperty('nativeSessionId');
    expect(state.createCalls).toHaveLength(0);
    expect(state.validateCalls).toHaveLength(1);
    expect(state.forkCalls).toHaveLength(1);
    expect(state.forkCalls[0].source).toEqual({
      applicationSessionId: 'caller',
      nativeSessionId: `native-${adapter}`,
      cwd: process.cwd(),
    });
    expect(state.linkCalls).toEqual([{ sid: 'child-1', parent: 'caller', depth: 1 }]);
    expect(state.placeholders).toHaveLength(1);
    expect(state.sessions.get('caller')).toEqual(before);
  });

  it.each([undefined, 'fresh'] as const)('%s mode uses only the ordinary create path', async (mode) => {
    seedCaller('claude-code');
    const { raw, data } = await call('claude-code', mode);

    expect(raw.isError).toBeUndefined();
    expect(data).not.toHaveProperty('contextMode');
    expect(data).not.toHaveProperty('forkedFromSessionId');
    expect(state.createCalls).toHaveLength(1);
    expect(state.validateCalls).toHaveLength(0);
    expect(state.forkCalls).toHaveLength(0);
  });

  it('rejects generic/provider preflight failures before guard and team mutation', async () => {
    seedCaller('claude-code');
    const crossAdapter = await call('codex-cli', 'fork', 'never-created');
    expect(crossAdapter.raw.isError).toBe(true);
    expect(crossAdapter.data.error).toContain('requires caller adapter "claude-code"');
    expect(state.guardCalls).toBe(0);
    expect(state.ensureTeamCalls).toHaveLength(0);

    state.validateThrow = new Error('provider transcript root mismatch');
    const provider = await call('claude-code', 'fork', 'still-never-created');
    expect(provider.raw.isError).toBe(true);
    expect(provider.data.error).toBe('provider transcript root mismatch');
    expect(provider.data.hint).toContain('contextMode "fresh"');
    expect(state.guardCalls).toBe(0);
    expect(state.ensureTeamCalls).toHaveLength(0);
  });

  it('releases the reservation and cleans a new team when native creation fails', async () => {
    const source = seedCaller('claude-code');
    const before = structuredClone(source);
    state.forkThrow = new Error('native fork RPC failed');
    const { raw, data } = await call('claude-code', 'fork', 'fork-failure');

    expect(raw.isError).toBe(true);
    expect(data.error).toBe('native fork RPC failed');
    expect(data.hint).toContain('contextMode "fresh"');
    expect(state.guardReleases).toBe(1);
    expect(state.cleanupCalls).toContain('createSession failure');
    expect(state.membershipCalls).toHaveLength(0);
    expect(state.placeholders).toHaveLength(0);
    expect(state.sessions.get('caller')).toEqual(before);
  });

  it('closes before idempotent discard when mandatory membership fails', async () => {
    seedCaller('claude-code');
    state.teamFailure = true;
    const { raw } = await call('claude-code', 'fork', 'fork-team');

    expect(raw.isError).toBe(true);
    expect(state.order).toEqual(['close:child-1', 'discard:child-1']);
    expect(state.discardCalls).toEqual(['child-1']);
    expect(state.sessions.has('child-1')).toBe(false);
    expect(state.sessions.has('caller')).toBe(true);
  });

  it('keeps explicit-team membership, spawn link, and reply anchor behavior', async () => {
    seedCaller('codex-cli');
    const { raw, data } = await call('codex-cli', 'fork', 'native-fork-team');

    expect(raw.isError).toBeUndefined();
    expect(data.teamId).toBe('team-native-fork-team');
    expect(state.membershipCalls).toEqual(['child-1']);
    expect(state.linkCalls).toEqual([{ sid: 'child-1', parent: 'caller', depth: 1 }]);
    expect(state.placeholders).toEqual([
      expect.objectContaining({
        teamId: 'team-native-fork-team',
        fromSessionId: 'caller',
        toSessionId: 'child-1',
        body: 'delegated task',
      }),
    ]);
    expect(data.spawnPromptMessageId).toBe(state.placeholders[0].id);
  });

  it('keeps hand-offs fresh and rejects an internal fork request instead of downgrading it', async () => {
    seedCaller('claude-code');
    const fresh = await call('claude-code', undefined, undefined, true);
    expect(fresh.raw.isError).toBeUndefined();
    expect(state.createCalls).toHaveLength(1);
    expect(state.validateCalls).toHaveLength(0);

    state.createCalls.length = 0;
    const rejected = await call('claude-code', 'fork', undefined, true);
    expect(rejected.raw.isError).toBe(true);
    expect(rejected.data.error).toContain('hand_off_session always starts a fresh successor');
    expect(state.createCalls).toHaveLength(0);
    expect(state.forkCalls).toHaveLength(0);
  });
});
