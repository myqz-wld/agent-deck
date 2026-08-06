import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessContext } from '@contracts/index';
import type { SessionConsoleExecutionContext } from '@core/session-console';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import type { ServerCoreProject } from './project-catalog';
import {
  ServerCoreSessionConsoleAuthority,
  type ServerCoreSessionConsoleMetadataPort,
  type ServerCoreSessionConsoleRepositoryPort,
} from './session-console-authority';

const roots: string[] = [];

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    cwd: '/workspaces/private',
    title: `title ${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 10,
    lastEventAt: 20,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function workspace(): { root: string; path: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agent-deck-console-authority-'));
  roots.push(parent);
  const root = join(parent, 'workspaces');
  const path = join(root, 'alpha');
  mkdirSync(path, { recursive: true });
  return { root: realpathSync(root), path: realpathSync(path) };
}

function context(access?: AccessContext): SessionConsoleExecutionContext {
  return {
    access: access ?? {
      kind: 'authenticated-client',
      topology: 'server-core',
      instanceId: 'instance-a',
      clientId: 'client-a',
      transport: 'ssh',
      accessCredentialId: 'credential-a',
      authority: 'owner-equivalent',
      surface: 'desktop-full',
    },
    idempotencyKey: 'create-a',
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness() {
  const paths = workspace();
  const live = [record('live-a'), record('live-b')];
  const history = [record('closed-a', { lifecycle: 'closed', endedAt: 20 })];
  const all = new Map([...live, ...history].map((value) => [value.id, value]));
  const repository: ServerCoreSessionConsoleRepositoryPort = {
    get: (id) => all.get(id) ?? null,
    listLive: (limit, offset) => live.slice(offset, offset + limit),
    listHistory: (limit, offset) => history.slice(offset, offset + limit),
    countLive: () => live.length,
    countHistory: () => history.length,
  };
  let revision = 3;
  let claim: ReturnType<ServerCoreSessionConsoleMetadataPort['claimMutation']> = {
    state: 'claimed',
  };
  const completeMutation = vi.fn();
  const metadata: ServerCoreSessionConsoleMetadataPort = {
    currentRevision: () => revision,
    appendChange: vi.fn(() => ++revision),
    claimMutation: vi.fn(() => claim),
    completeMutation,
  };
  const createSession = vi.fn(() => Promise.resolve('created-session'));
  const adapter = {
    id: 'claude-code',
    displayName: 'Claude',
    capabilities: {},
    init: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    createSession,
  } as unknown as AgentAdapter;
  const project: ServerCoreProject = {
    projectId: 'project-alpha',
    projectRef: 'opaque-alpha',
    alias: 'alpha',
    title: 'Project Alpha',
    workspacePath: paths.path,
  };
  const authority = new ServerCoreSessionConsoleAuthority({
    projects: [project],
    workspaceRoot: paths.root,
    repository,
    registry: { get: (id) => id === 'claude-code' ? adapter : undefined },
    metadata,
  });
  return {
    authority,
    completeMutation,
    createSession,
    metadata,
    setClaim: (value: typeof claim) => { claim = value; },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreSessionConsoleAuthority', () => {
  it('paginates live and historical session projections without cwd disclosure', () => {
    const { authority } = harness();
    const first = authority.listSessions({ limit: 1 }, context());
    expect(first).toEqual({
      sessions: [{
        id: 'live-a', adapterId: 'claude-code', title: 'title live-a',
        status: 'active-idle', createdAt: 10, updatedAt: 20,
      }],
      nextCursor: 'v1:live:1',
      total: 2,
      revision: 3,
    });
    expect(first.sessions[0]).not.toHaveProperty('cwd');
    expect(authority.listSessions({
      limit: 1,
      cursor: first.nextCursor!,
    }, context()).sessions[0]?.id).toBe('live-b');
    expect(authority.listSessions({ limit: 10, includeArchived: true }, context()))
      .toMatchObject({ sessions: [{ id: 'closed-a' }], total: 1 });
  });

  it('lists and resolves only public project references', () => {
    const { authority } = harness();
    const listed = authority.listProjects({ limit: 10 }, context());
    expect(listed).toEqual({
      projects: [{
        projectId: 'project-alpha', projectRef: 'opaque-alpha',
        alias: 'alpha', title: 'Project Alpha',
      }],
      nextCursor: null,
      total: 1,
      revision: 3,
    });
    expect(listed.projects[0]).not.toHaveProperty('workspacePath');
    expect(authority.resolveProject({ alias: 'alpha' }, context()).project)
      .toEqual(listed.projects[0]);
  });

  it('creates through the exact adapter and completes durable idempotency', async () => {
    const { authority, completeMutation, createSession } = harness();
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code',
      projectRef: 'opaque-alpha',
      options: {},
    }, context())).resolves.toEqual({ sessionId: 'created-session', revision: 4 });
    expect(createSession).toHaveBeenCalledWith({
      agentId: 'claude-code',
      cwd: expect.stringContaining('/workspaces/alpha'),
      awaitCanonicalId: true,
    });
    expect(completeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        accessCredentialId: 'credential-a',
        method: 'session.console.create',
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      { sessionId: 'created-session', revision: 4 },
      4,
    );
  });

  it('returns completed mutations without invoking a provider twice', async () => {
    const { authority, createSession, setClaim } = harness();
    setClaim({
      state: 'completed',
      result: { sessionId: 'prior-session', revision: 9 },
      revision: 9,
    });
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code', projectRef: 'opaque-alpha', options: {},
    }, context())).resolves.toEqual({ sessionId: 'prior-session', revision: 9 });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('fails closed for ambiguous, conflicting, or widened creates', async () => {
    const { authority, setClaim } = harness();
    setClaim({ state: 'uncertain' });
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code', projectRef: 'opaque-alpha', options: {},
    }, context())).rejects.toMatchObject({ code: 'provider_lost' });
    setClaim({ state: 'conflict' });
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code', projectRef: 'opaque-alpha', options: {},
    }, context())).rejects.toMatchObject({ code: 'conflict' });
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code', projectRef: 'opaque-alpha', options: { cwd: '/escape' },
    }, context())).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a non-owner context before claiming mutation authority', async () => {
    const { authority, metadata } = harness();
    await expect(authority.createSessionByProject({
      adapterId: 'claude-code', projectRef: 'opaque-alpha', options: {},
    }, context({
      kind: 'standalone', topology: 'standalone', instanceId: 'local',
      clientId: 'local', transport: 'local-ipc', accessCredentialId: null,
      authority: 'local-owner', surface: 'desktop-full',
    }))).rejects.toMatchObject({ code: 'access_denied' });
    expect(metadata.claimMutation).not.toHaveBeenCalled();
  });
});
