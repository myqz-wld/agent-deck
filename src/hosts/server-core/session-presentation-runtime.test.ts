import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionPresentationPage } from '@main/store/session-repo/presentation';
import type { SessionRecord, SessionTeamMembership, SummaryRecord } from '@shared/types';
import { ServerCoreSessionPresentationRuntime } from './session-presentation-runtime';

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'server-core', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', accessCredentialId: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop-full',
};

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id, agentId: 'codex-cli', cwd: `/workspaces/${id}`, title: id, source: 'sdk',
    lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 2,
    endedAt: null, archivedAt: null, pinnedAt: null, spawnedBy: null, spawnDepth: 0,
    ...overrides,
  } as SessionRecord;
}

function request(method: CoreMethod, params: JsonObject): DaemonRequestInput {
  return {
    access, requestId: `request-${method}`, method, params, idempotencyKey: null,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
  };
}

function harness(options: {
  records?: SessionRecord[];
  pendingIds?: ReadonlySet<string>;
} = {}) {
  let revision = 8;
  const lead = record('lead-a', {
    title: 'Lead sk-sensitive-token', activity: 'working', pinnedAt: 3,
  });
  const child = record('child-a', {
    activity: 'waiting', spawnedBy: lead.id, spawnDepth: 1,
  });
  const dormant = record('dormant-a', { lifecycle: 'dormant' });
  const all = options.records ?? [lead, child, dormant];
  const memberships = new Map<string, SessionTeamMembership[]>([
    [lead.id, [{ teamId: 'team-a', teamName: 'Parity Team', role: 'lead', joinedAt: 1 }]],
    [child.id, [{ teamId: 'team-a', teamName: 'Parity Team', role: 'teammate', joinedAt: 1 }]],
  ]);
  const summaries: Record<string, SummaryRecord> = {
    [child.id]: {
      id: 1, sessionId: child.id, content: 'Summary token=top-secret-value', trigger: 'manual',
      ts: 2, sourceEventRevision: 1, sourceRebuildAfterRevision: 0, generationSource: 'llm',
    },
  };
  const page = (rows: SessionRecord[], limit: number, offset: number): SessionPresentationPage => ({
    records: rows.slice(offset, offset + limit).map((item) => ({ record: item, contextOnly: false })),
    contextTruncated: false,
  });
  const adapter = {
    listPending: (sessionId: string) => ({
      permissions: (options.pendingIds?.has(sessionId) ?? sessionId === child.id) ? [{
        type: 'permission-request' as const,
        requestId: 'permission-a',
        toolName: 'Read',
        toolInput: { file_path: '/workspaces/child-a/README.md' },
      }] : [],
      askQuestions: [],
      exitPlanModes: [],
    }),
  } as Partial<AgentAdapter> as AgentAdapter;
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: () => revision,
    execute: vi.fn(async () => ({ result: { ok: true }, revision })),
  };
  const listHistory = vi.fn((_query: string | undefined, _archivedOnly: boolean, limit: number, offset: number) =>
    page([dormant], limit, offset));
  const counts = vi.fn((kind: 'history' | 'live') => kind === 'live'
    ? { total: 3, active: 2, dormant: 1, closed: 0, working: 1, waiting: 1 }
    : { total: 1, active: 0, dormant: 1, closed: 0, working: 0, waiting: 0 });
  const runtime = new ServerCoreSessionPresentationRuntime(base, {
    repository: {
      listLive: (limit, offset) => page(all, limit, offset),
      listHistory,
      counts,
      listPendingCandidates: () => all,
      memberships: (ids) => new Map(ids.flatMap((id) =>
        memberships.has(id) ? [[id, memberships.get(id)!] as const] : [])),
      summaries: (ids) => Object.fromEntries(ids.flatMap((id) =>
        summaries[id] ? [[id, summaries[id]] as const] : [])),
    },
    registry: { get: () => adapter },
    presentations: { list: () => [] },
    projects: [],
    workspaceRoot: '/workspaces',
    currentRevision: () => revision,
  });
  return { counts, listHistory, runtime, setRevision: (next: number) => { revision = next; } };
}

describe('ServerCoreSessionPresentationRuntime', () => {
  it('forwards the archived-only history filter into rows and authoritative counts', async () => {
    const { counts, listHistory, runtime } = harness();
    await runtime.execute(request('session.presentation.list', {
      kind: 'history', archivedOnly: true, limit: 20,
    }));
    expect(listHistory).toHaveBeenCalledWith(undefined, true, 20, 0);
    expect(counts).toHaveBeenCalledWith('history', undefined, true);
  });

  it('returns typed rich rows, authoritative counts and no private cwd/secret text', async () => {
    const { runtime } = harness();
    const response = await runtime.execute(request('session.presentation.list', {
      kind: 'live', limit: 2,
    }));
    expect(response.result).toMatchObject({
      counts: { total: 3, active: 2, dormant: 1, working: 1, waiting: 1 },
      sessions: [
        { id: 'lead-a', pinned: true, teams: [{ role: 'lead' }] },
        { id: 'child-a', spawnedBy: 'lead-a', summary: null },
      ],
      nextCursor: 'v1:live:8:2',
    });
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain('/workspaces/');
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('sk-sensitive-token');
  });

  it('binds pagination cursors to the Core revision', async () => {
    const { runtime, setRevision } = harness();
    const first = await runtime.execute(request('session.presentation.list', {
      kind: 'live', limit: 1,
    }));
    const cursor = (first.result as { nextCursor: string }).nextCursor;
    setRevision(9);
    await expect(Promise.resolve().then(() => runtime.execute(request(
      'session.presentation.list',
      { kind: 'live', limit: 1, cursor },
    )))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('aggregates Pending in one bounded Core request', async () => {
    const { runtime } = harness();
    const response = await runtime.execute(request('pending.index.list', { limit: 25 }));
    expect(response.result).toMatchObject({
      totalBuckets: 1,
      totalRequests: 1,
      scanTruncated: false,
      buckets: [{
        session: { id: 'child-a', activity: 'waiting' },
        requests: [{ id: 'permission-a', sessionId: 'child-a', kind: 'permission' }],
      }],
    });
  });

  it('finds Pending beyond the first forty Live sessions without desktop N+1 hydration', async () => {
    const records = Array.from({ length: 41 }, (_, index) => record(`session-${index}`));
    const targetId = records[40]!.id;
    const { runtime } = harness({ records, pendingIds: new Set([targetId]) });
    const response = await runtime.execute(request('pending.index.list', { limit: 25 }));
    expect(response.result).toMatchObject({
      totalBuckets: 1,
      totalRequests: 1,
      buckets: [{ session: { id: targetId } }],
    });
  });
});
