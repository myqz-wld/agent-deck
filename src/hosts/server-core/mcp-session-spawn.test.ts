import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { AgentAdapter } from '@main/adapters/types';
import {
  createAgentDeckMessageRepo,
  type AgentDeckMessageRepo,
} from '@main/store/agent-deck-message-repo';
import { createAgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import {
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import type { SessionRecord } from '@shared/types';

import { ServerCoreMcpSessionSpawner } from './mcp-session-spawn';
import { ServerCoreSpawnCollaboration } from './mcp-spawn-collaboration';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type {
  ServerCoreSessionConsoleAuthority,
  ServerCoreSessionSpawnCreateInput,
} from './session-console-authority';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';

const databases: Database.Database[] = [];

function session(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/workspace',
    title: `title-${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function harness(input: { failAnchor?: boolean; callerDepth?: number } = {}) {
  const database = makeMemoryDb();
  databases.push(database);
  insertSession(database, 'caller', 'codex-cli');
  const records = new Map<string, SessionRecord>([
    ['caller', session('caller', { spawnDepth: input.callerDepth ?? 0 })],
  ]);
  const sessions = {
    get: (id: string) => records.get(id) ?? null,
    listChildren: (parentId: string, lifecycle: 'active') => [...records.values()].filter(
      (row) => row.spawnedBy === parentId && row.lifecycle === lifecycle,
    ),
    setSpawnLink: (id: string, parentSessionId: string, depth: number) => {
      const row = records.get(id);
      if (row) records.set(id, { ...row, spawnedBy: parentSessionId, spawnDepth: depth });
    },
    setTitle: (id: string, title: string) => {
      const row = records.get(id);
      if (row) records.set(id, { ...row, title });
    },
  };
  const teams = createAgentDeckTeamRepo(database);
  const messages = createAgentDeckMessageRepo(database);
  const effectiveMessages = input.failAnchor
    ? new Proxy(messages, {
        get(target, key, receiver) {
          if (key === 'markDelivered') return () => null;
          return Reflect.get(target, key, receiver) as unknown;
        },
      }) as AgentDeckMessageRepo
    : messages;
  const notifyMembershipChanged = vi.fn();
  const collaboration = new ServerCoreSpawnCollaboration({
    teams,
    messages: effectiveMessages,
    sessions,
    transaction: <T>(operation: () => T) => database.transaction(operation)(),
    notifyMembershipChanged,
    now: () => 5_000,
  });
  let registeredBeforeResolve = false;
  const createSpawnSession = vi.fn(async (create: ServerCoreSessionSpawnCreateInput) => {
    const id = 'child';
    insertSession(database, id, create.params.adapterId);
    records.set(id, session(id, {
      agentId: create.params.adapterId,
      cwd: `/workspace/${create.params.workingDirectory}`,
      spawnedBy: create.initialSessionRegistration.spawnLink.parentSessionId,
      spawnDepth: create.initialSessionRegistration.spawnLink.depth,
    }));
    create.initialSessionRegistration.onRegistered(id);
    registeredBeforeResolve = true;
    return { sessionId: id, revision: 2 };
  });
  const describe = vi.fn(async (params: { adapterId: 'claude-code' | 'codex-cli' | 'grok-build'; workingDirectory: string }) =>
    sessionConsoleCapabilitiesFixture(params.adapterId, params.workingDirectory));
  const validateCreate = vi.fn(async (
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
    _revision: string,
    cwd: string,
  ) => sessionConsoleCapabilitiesFixture(adapterId, cwd));
  const closeSessionForRollback = vi.fn(async () => undefined);
  const adapter = { closeSessionForRollback } as unknown as AgentAdapter;
  const discardAfterProviderRollback = vi.fn((id: string) => {
    records.delete(id);
    database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  const appendChange = vi.fn(() => 3);
  const spawner = new ServerCoreMcpSessionSpawner({
    sessions,
    sessionManager: {
      recordCreatedPermissionMode: vi.fn(),
      discardAfterProviderRollback,
    },
    registry: { get: () => adapter },
    capabilities: { describe, validateCreate } as unknown as ServerCoreSessionCreateCapabilities,
    authority: { createSpawnSession } as unknown as ServerCoreSessionConsoleAuthority,
    collaboration,
    metadata: { appendChange } as unknown as ServerCoreRuntimeMetadataStore,
    now: () => 5_000,
  });
  return {
    appendChange,
    closeSessionForRollback,
    collaboration,
    createSpawnSession,
    database,
    describe,
    discardAfterProviderRollback,
    messages,
    notifyMembershipChanged,
    records,
    registeredBeforeResolve: () => registeredBeforeResolve,
    spawner,
    teams,
    validateCreate,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('ServerCoreMcpSessionSpawner', () => {
  it('creates a linked provider child with Core defaults, team membership, and reply anchor', async () => {
    const state = harness();
    const result = await state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      cwd: 'project-a',
      prompt: 'Inspect the bounded project',
      teamName: 'review-team',
      displayName: 'Reviewer',
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'never',
      codexSandbox: 'read-only',
    });
    expect(result).toMatchObject({
      sessionId: 'child',
      adapter: 'codex-cli',
      cwd: 'project-a',
      teamName: 'review-team',
      displayName: 'Reviewer',
      spawnDepth: 1,
      contextMode: 'fresh',
    });
    expect(JSON.stringify(result)).not.toContain('/workspace');
    expect(state.registeredBeforeResolve()).toBe(true);
    expect(state.records.get('child')).toMatchObject({
      spawnedBy: 'caller',
      spawnDepth: 1,
      title: 'Reviewer',
    });
    const create = state.createSpawnSession.mock.calls[0]![0];
    expect(create.params.options).toMatchObject({
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'never',
      codexSandbox: 'read-only',
    });
    expect(create.params.initialMessage).toMatch(
      /^\[from title-caller @ codex-cli\]\[msg [0-9a-f-]+\]\[sid caller\]/,
    );
    expect(create.params.initialMessage).not.toContain('/workspace');
    const team = state.teams.getByActiveName('review-team');
    expect(team).not.toBeNull();
    expect(state.teams.listActiveMembers(team!.id).map((row) => [row.sessionId, row.role]))
      .toEqual([['caller', 'lead'], ['child', 'teammate']]);
    expect(state.messages.get(result.spawnPromptMessageId)).toMatchObject({
      fromSessionId: 'caller',
      toSessionId: 'child',
      body: 'Inspect the bounded project',
      status: 'delivered',
    });
    expect(state.notifyMembershipChanged).toHaveBeenCalledTimes(2);
    expect(state.validateCreate).toHaveBeenCalledOnce();
  });

  it('rejects absolute and traversal cwd values before provider or team creation', async () => {
    const state = harness();
    for (const cwd of ['/workspace/project', '../project']) {
      await expect(state.spawner.spawn('caller', {
        adapter: 'codex-cli', cwd, prompt: 'Inspect', teamName: 'must-not-exist',
      })).rejects.toThrow(/workspaceDirectory|spawn_session\.cwd|Workspace-relative/i);
    }
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.teams.getByActiveName('must-not-exist')).toBeNull();
  });

  it('strictly rolls back a registered child when the anchor transaction fails', async () => {
    const state = harness({ failAnchor: true });
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', cwd: '.', prompt: 'Inspect',
    })).rejects.toThrow('reply anchor');
    expect(state.closeSessionForRollback).toHaveBeenCalledWith('child');
    expect(state.discardAfterProviderRollback).toHaveBeenCalledWith('child');
    expect(state.records.has('child')).toBe(false);
    expect(state.messages.listBySession('caller')).toEqual([]);
  });

  it('enforces the Core recursion guard without invoking a provider', async () => {
    const state = harness({ callerDepth: 3 });
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', cwd: '.', prompt: 'Delegate again',
    })).rejects.toMatchObject({
      name: 'ServerCoreSpawnGuardError',
      spawnLimits: { depth: { current: 3, next: 4, max: 3 } },
    });
    expect(state.createSpawnSession).not.toHaveBeenCalled();
  });

  it('revalidates caller liveness after capability awaits and before provider creation', async () => {
    const state = harness();
    let releaseDescribe!: () => void;
    const describeGate = new Promise<void>((resolve) => { releaseDescribe = resolve; });
    state.describe.mockImplementationOnce(async (params) => {
      await describeGate;
      return sessionConsoleCapabilitiesFixture(params.adapterId, params.workingDirectory);
    });
    const spawning = state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      cwd: '.',
      prompt: 'Must not outlive the caller',
      teamName: 'must-not-exist',
    });
    await vi.waitFor(() => expect(state.describe).toHaveBeenCalledOnce());
    state.records.set('caller', session('caller', { lifecycle: 'closed' }));
    releaseDescribe();

    await expect(spawning).rejects.toThrow('no longer live');
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.teams.getByActiveName('must-not-exist')).toBeNull();
  });
});
