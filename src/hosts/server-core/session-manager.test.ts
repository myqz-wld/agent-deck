import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';
import {
  ServerCoreSessionManager,
  type ServerCoreSessionRepositoryPort,
} from './session-manager';

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    cwd: '/srv/project',
    title: 'project',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 10,
    lastEventAt: 10,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function event(
  sessionId: string,
  kind: AgentEvent['kind'],
  overrides: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    sessionId,
    agentId: 'claude-code',
    kind,
    payload: {},
    ts: 20,
    source: 'sdk',
    ...overrides,
  };
}

function createHarness(initial: SessionRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, { ...record }]));
  const persisted: AgentEvent[] = [];
  let now = 100;
  const requireRecord = (id: string): SessionRecord => {
    const record = records.get(id);
    if (!record) throw new Error(`missing ${id}`);
    return record;
  };
  const replace = (id: string, patch: Partial<SessionRecord>): SessionRecord => {
    const updated = { ...requireRecord(id), ...patch };
    records.set(id, updated);
    return updated;
  };
  const repository: ServerCoreSessionRepositoryPort = {
    get: (id) => records.get(id) ?? null,
    findByCliSessionId: (cliId) =>
      [...records.values()].find((record) => record.cliSessionId === cliId) ?? null,
    listLiveForUi: (limit = 100) => [...records.values()]
      .filter((record) => record.archivedAt === null && record.lifecycle !== 'closed')
      .slice(0, limit),
    upsert: (record) => records.set(record.id, { ...record }),
    setActivity: (id, activity, at) => { replace(id, { activity, lastEventAt: at }); },
    setEventState: (id, activity, lifecycle, at, options) => {
      replace(id, {
        activity,
        lifecycle,
        lastEventAt: at,
        endedAt: lifecycle === 'closed' ? at : null,
        ...(options?.clearPinned ? { pinnedAt: null } : {}),
      });
    },
    setLifecycle: (id, lifecycle, at, options) => {
      replace(id, {
        lifecycle,
        endedAt: lifecycle === 'closed' ? at : null,
        ...(options?.clearPinned ? { pinnedAt: null } : {}),
      });
    },
    setArchived: (id, archivedAt) => { replace(id, { archivedAt }); },
    setPinned: (id, pinnedAt) => replace(id, { pinnedAt }),
    setPermissionMode: (id, permissionMode) => { replace(id, { permissionMode }); },
    hideFromHistory: (id) => { replace(id, { hiddenFromHistory: true }); },
    setSpawnLink: (id, spawnedBy, spawnDepth) => { replace(id, { spawnedBy, spawnDepth }); },
    rename: (fromId, toId) => {
      const record = requireRecord(fromId);
      records.delete(fromId);
      records.set(toId, { ...record, id: toId });
    },
    updateCliSessionId: (id, cliSessionId) => { replace(id, { cliSessionId }); },
    delete: (id) => { records.delete(id); },
  };
  const observer = {
    eventPersisted: vi.fn(),
    tokenUsageObserved: vi.fn(),
    contextUsageObserved: vi.fn(),
    contextCompactionObserved: vi.fn(),
    sessionUpdated: vi.fn(),
    sessionRemoved: vi.fn(),
    sessionRenamed: vi.fn(),
    warning: vi.fn(),
  };
  const handOffLifecycle = {
    revokeSource: vi.fn(),
    restoreSource: vi.fn(),
    abortSource: vi.fn(),
    reactivateSource: vi.fn(),
    renameSource: vi.fn(),
  };
  const manager = new ServerCoreSessionManager({
    sessions: repository,
    events: {
      insert: vi.fn((input: AgentEvent) => {
        persisted.push(input);
        return persisted.length;
      }),
    },
    observer,
    now: () => now,
    handOffLifecycle,
  });
  const close = vi.fn<(agentId: string, sessionId: string) => Promise<void>>(
    () => Promise.resolve(),
  );
  const rename = vi.fn<(agentId: string, fromId: string, toId: string) => void>();
  manager.installSessionClose(close);
  manager.installSessionRename(rename);
  return {
    close,
    handOffLifecycle,
    manager,
    observer,
    persisted,
    records,
    rename,
    setNow: (value: number) => { now = value; },
  };
}

describe('ServerCoreSessionManager', () => {
  it('routes token usage to telemetry persistence without polluting session history', () => {
    const harness = createHarness([session('usage-session')]);
    const usage = event('usage-session', 'token-usage', {
      payload: {
        messageId: 'usage-message',
        model: 'gpt-5.6-sol',
        inputTokens: 120,
        outputTokens: 8,
      },
    });

    harness.manager.ingest(usage);

    expect(harness.observer.tokenUsageObserved).toHaveBeenCalledOnce();
    expect(harness.observer.tokenUsageObserved).toHaveBeenCalledWith(usage);
    expect(harness.persisted).toEqual([]);
    expect(harness.observer.eventPersisted).not.toHaveBeenCalled();
    expect(harness.records.get('usage-session')).toEqual(session('usage-session'));
  });

  it('routes context snapshots off-timeline and observes compaction resets', () => {
    const harness = createHarness([session('context-session')]);
    const usage = event('context-session', 'context-usage', {
      payload: { usedTokens: 320, windowTokens: 1_000_000 },
    });
    const compaction = event('context-session', 'context-compaction-start', {
      payload: { reason: 'provider-compaction' },
      ts: 21,
    });

    harness.manager.ingest(usage);

    expect(harness.observer.contextUsageObserved).toHaveBeenCalledWith(usage);
    expect(harness.persisted).toEqual([]);
    expect(harness.observer.eventPersisted).not.toHaveBeenCalled();

    harness.manager.ingest(compaction);

    expect(harness.observer.contextCompactionObserved).toHaveBeenCalledWith(compaction);
    expect(harness.persisted).toEqual([compaction]);
    expect(harness.observer.eventPersisted).toHaveBeenCalledWith(compaction, 1);
  });

  it('persists trusted first-registration metadata and keeps buffered handoff input idle', () => {
    const harness = createHarness();
    harness.manager.ingest(event('child', 'session-start', {
      payload: {
        cwd: '/srv/project',
        initialHiddenFromHistory: true,
        initialSpawnLink: { parentSessionId: 'parent', depth: 2 },
      },
    }));
    harness.manager.ingest(event('child', 'message', {
      payload: { role: 'user', text: 'queued', handOffBuffered: true },
      ts: 21,
    }));

    expect(harness.records.get('child')).toMatchObject({
      hiddenFromHistory: true,
      spawnedBy: 'parent',
      spawnDepth: 2,
      activity: 'idle',
      lastEventAt: 21,
    });
    expect(harness.persisted).toHaveLength(2);
    expect(harness.observer.eventPersisted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'child', kind: 'message' }),
      2,
    );
  });

  it('fences hook duplicates through exact SDK and pending-cwd claims', () => {
    const harness = createHarness();
    harness.manager.claimAsSdk('owned');
    harness.manager.ingest(event('owned', 'message', {
      source: 'hook',
      payload: { role: 'assistant' },
    }));
    const cancel = harness.manager.expectSdkSession('/srv/project', 10);
    harness.manager.ingest(event('native-id', 'session-start', {
      source: 'hook',
      payload: { cwd: '/srv/project' },
    }));
    cancel();

    expect(harness.persisted).toHaveLength(0);
    expect(harness.records.size).toBe(0);
    expect(harness.manager.hasSdkClaim('native-id')).toBe(true);
  });

  it('revives a closed session only for an explicit SDK user message', () => {
    const harness = createHarness([session('closed', {
      lifecycle: 'closed',
      endedAt: 12,
    })]);
    harness.manager.ingest(event('closed', 'tool-use-end', { ts: 30 }));
    expect(harness.records.get('closed')).toMatchObject({ lifecycle: 'closed', endedAt: 12 });

    harness.manager.ingest(event('closed', 'message', {
      payload: { role: 'user', text: 'continue' },
      ts: 31,
    }));
    expect(harness.records.get('closed')).toMatchObject({
      lifecycle: 'active',
      activity: 'working',
      endedAt: null,
      lastEventAt: 31,
    });
    expect(harness.persisted).toHaveLength(2);
  });

  it('maps native CLI identities before persistence and terminalizes archived sessions', () => {
    const harness = createHarness([session('application-id', {
      cliSessionId: 'native-id',
      archivedAt: 15,
    })]);
    harness.manager.ingest(event('native-id', 'session-end', {
      source: 'sdk',
      ts: 40,
    }));

    expect(harness.persisted[0]?.sessionId).toBe('application-id');
    expect(harness.records.get('application-id')).toMatchObject({
      lifecycle: 'dormant',
      archivedAt: 15,
    });
  });

  it('closes durably even when provider cleanup rejects', async () => {
    const harness = createHarness([session('close-me', { pinnedAt: 11 })]);
    harness.close.mockRejectedValueOnce(new Error('private provider detail'));

    await expect(harness.manager.close('close-me')).resolves.toBeUndefined();

    expect(harness.close).toHaveBeenCalledWith('claude-code', 'close-me');
    expect(harness.records.get('close-me')).toMatchObject({
      lifecycle: 'closed',
      endedAt: 100,
      pinnedAt: null,
    });
    expect(harness.manager.getCloseEpoch('close-me')).toBe(1);
    expect(harness.observer.warning).toHaveBeenCalledWith(
      'Server Core provider close failed',
      expect.any(Error),
    );
  });

  it('deletes durably, fences late tails, and permits an explicit new user continuation', async () => {
    const harness = createHarness([session('remove-me', { cliSessionId: 'native-remove' })]);
    await harness.manager.delete('remove-me');
    harness.manager.ingest(event('remove-me', 'session-end', { ts: 101 }));
    harness.manager.ingest(event('native-remove', 'session-end', {
      source: 'hook',
      ts: 102,
    }));
    expect(harness.records.size).toBe(0);
    expect(harness.persisted).toHaveLength(0);

    harness.manager.ingest(event('remove-me', 'message', {
      payload: { role: 'user', text: 'new intent' },
      ts: 103,
    }));
    expect(harness.records.get('remove-me')).toMatchObject({ lifecycle: 'active' });
    expect(harness.persisted).toHaveLength(1);
    expect(harness.observer.sessionRemoved).toHaveBeenCalledWith('remove-me');
  });

  it('transfers SDK ownership and provider identity during rename', () => {
    const harness = createHarness([session('before')]);
    harness.manager.claimAsSdk('before');
    harness.manager.renameSdkSession('before', 'after');

    expect(harness.records.has('before')).toBe(false);
    expect(harness.manager.hasSdkClaim('before')).toBe(false);
    expect(harness.manager.hasSdkClaim('after')).toBe(true);
    expect(harness.rename).toHaveBeenCalledWith('claude-code', 'before', 'after');
    expect(harness.observer.sessionRenamed).toHaveBeenCalledWith('before', 'after');
  });

  it('fences handoff ownership across close, archive, rollback cleanup, and rename', async () => {
    const harness = createHarness([
      session('close-a'),
      session('archive-a'),
      session('rollback-a'),
      session('rename-a'),
    ]);

    harness.manager.bumpCloseEpoch('close-a');
    harness.manager.forgetCloseEpoch('close-a');
    await harness.manager.archive('archive-a');
    harness.manager.reactivate('archive-a');
    harness.manager.discardAfterProviderRollback('rollback-a');
    harness.manager.renameSdkSession('rename-a', 'rename-b');

    expect(harness.handOffLifecycle.revokeSource).toHaveBeenNthCalledWith(1, 'close-a');
    expect(harness.handOffLifecycle.restoreSource).toHaveBeenCalledWith('close-a');
    expect(harness.handOffLifecycle.abortSource).toHaveBeenCalledWith('archive-a');
    expect(harness.handOffLifecycle.reactivateSource).toHaveBeenCalledWith('archive-a');
    expect(harness.handOffLifecycle.revokeSource).toHaveBeenCalledWith('rollback-a');
    expect(harness.handOffLifecycle.restoreSource).toHaveBeenCalledWith('rollback-a');
    expect(harness.handOffLifecycle.renameSource).toHaveBeenCalledWith('rename-a', 'rename-b');
  });

  it('keeps missing unarchive and closed-side-effect operations inert', async () => {
    const harness = createHarness();
    await expect(harness.manager.unarchiveOnUserSend('missing')).resolves.toBeUndefined();
    expect(harness.manager.hasPendingCloseSideEffects('missing')).toBe(false);
    await expect(harness.manager.runClosedSideEffects('missing', {})).resolves.toBeUndefined();
    expect(harness.records.size).toBe(0);
  });

  it('expires pending cwd and deletion fences deterministically', async () => {
    const harness = createHarness([session('old')]);
    harness.manager.expectSdkSession('/srv/expired', 5);
    harness.setNow(106);
    harness.manager.ingest(event('hook-session', 'session-start', {
      source: 'hook',
      payload: { cwd: '/srv/expired' },
    }));
    expect(harness.records.has('hook-session')).toBe(true);

    await harness.manager.delete('old');
    harness.setNow(60_107);
    harness.manager.ingest(event('old', 'session-start', { source: 'hook' }));
    expect(harness.records.has('old')).toBe(true);
  });

  it('rejects malformed trusted spawn registrations before persistence', () => {
    const harness = createHarness();
    expect(() => harness.manager.ensure('bad-depth', {
      agentId: 'claude-code',
      source: 'sdk',
      spawnedBy: 'parent',
      spawnDepth: 0,
    })).toThrow('Server Core spawn depth must be positive');
    expect(() => harness.manager.ensure('missing-parent', {
      agentId: 'claude-code',
      source: 'sdk',
      spawnDepth: 1,
    })).toThrow('Server Core spawn depth requires a parent session');
    expect(harness.records.size).toBe(0);
  });
});
