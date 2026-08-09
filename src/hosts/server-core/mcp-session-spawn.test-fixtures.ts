import type Database from 'better-sqlite3';
import { vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type {
  AgentAdapter,
  CreateSessionOptions,
  ForkSessionSource,
} from '@main/adapters/types';
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

export function closeSpawnHarnessDatabases(): void {
  for (const database of databases.splice(0)) database.close();
}

export function session(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: process.cwd(),
    title: `title-${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    cliSessionId: `native-${id}`,
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

export function harness(input: { failAnchor?: boolean; callerDepth?: number } = {}) {
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
  const describe = vi.fn(async (params: {
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
    workingDirectory: string;
  }) => sessionConsoleCapabilitiesFixture(params.adapterId, params.workingDirectory));
  const validateCreate = vi.fn(async (
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
    _revision: string,
    cwd: string,
  ) => sessionConsoleCapabilitiesFixture(adapterId, cwd));
  const closeSessionForRollback = vi.fn(async () => undefined);
  const validateForkSession = vi.fn(async (
    _source: ForkSessionSource,
    _target: CreateSessionOptions,
  ) => undefined);
  const forkDiscard = vi.fn(async () => undefined);
  const createForkedSession = vi.fn(async (
    _source: ForkSessionSource,
    target: CreateSessionOptions,
  ) => {
    const id = 'child';
    insertSession(database, id, target.agentId);
    records.set(id, session(id, {
      agentId: target.agentId,
      cwd: target.cwd,
      spawnedBy: target.initialSessionRegistration?.spawnLink.parentSessionId,
      spawnDepth: target.initialSessionRegistration?.spawnLink.depth,
    }));
    target.initialSessionRegistration?.onRegistered(id);
    registeredBeforeResolve = true;
    return { sessionId: id, discard: forkDiscard };
  });
  const adapter = {
    capabilities: { canForkSession: true },
    closeSessionForRollback,
    createForkedSession,
    validateForkSession,
  } as unknown as AgentAdapter;
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
    capabilities: {
      describe,
      resolveWorkingDirectory: () => process.cwd(),
      validateCreate,
    } as unknown as ServerCoreSessionCreateCapabilities,
    authority: { createSpawnSession } as unknown as ServerCoreSessionConsoleAuthority,
    collaboration,
    metadata: { appendChange } as unknown as ServerCoreRuntimeMetadataStore,
    now: () => 5_000,
  });
  return {
    appendChange,
    closeSessionForRollback,
    collaboration,
    createForkedSession,
    createSpawnSession,
    describe,
    discardAfterProviderRollback,
    forkDiscard,
    insertSession: (id: string, adapterId: string) => insertSession(database, id, adapterId),
    messages,
    notifyMembershipChanged,
    records,
    registeredBeforeResolve: () => registeredBeforeResolve,
    spawner,
    teams,
    validateCreate,
    validateForkSession,
  };
}
