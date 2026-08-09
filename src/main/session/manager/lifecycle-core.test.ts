import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode, SessionRecord } from '@shared/types';
import type { SessionManagerInternalState } from './_deps';
import {
  SessionLifecycleCore,
  type SessionLifecycleCoreHost,
  type SessionLifecycleRepositoryPort,
} from './lifecycle-core';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'codex-cli',
    cwd: '/workspace',
    title: 'Session A',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    cliSessionId: 'cli-a',
    ...overrides,
  };
}

function state(): SessionManagerInternalState {
  return { recentlyDeleted: new Map(), closeEpoch: new Map() };
}

function fixture(initial: SessionRecord | null = record()) {
  const rows = new Map<string, SessionRecord>();
  if (initial) rows.set(initial.id, initial);
  let now = 100;
  const calls: string[] = [];
  const repository: SessionLifecycleRepositoryPort = {
    get: (sessionId) => rows.get(sessionId) ?? null,
    setLifecycle: (sessionId, lifecycle, at, options) => {
      calls.push(`lifecycle:${lifecycle}:${at}:${options?.clearPinned === true}`);
      const current = rows.get(sessionId);
      if (current) rows.set(sessionId, {
        ...current,
        lifecycle,
        lastEventAt: at,
        pinnedAt: options?.clearPinned ? null : current.pinnedAt,
      });
    },
    setArchived: (sessionId, archivedAt) => {
      calls.push(`archived:${String(archivedAt)}`);
      const current = rows.get(sessionId);
      if (current) rows.set(sessionId, { ...current, archivedAt });
    },
    setPinned: (sessionId, pinnedAt) => {
      calls.push(`pinned:${String(pinnedAt)}`);
      const updated = { ...rows.get(sessionId)!, pinnedAt };
      rows.set(sessionId, updated);
      return updated;
    },
    setPermissionMode: (sessionId, permissionMode: PermissionMode | null) => {
      calls.push(`permission:${String(permissionMode)}`);
      const current = rows.get(sessionId);
      if (current) rows.set(sessionId, { ...current, permissionMode });
    },
    delete: (sessionId) => {
      calls.push('delete-row');
      rows.delete(sessionId);
    },
  };
  const host: SessionLifecycleCoreHost = {
    repository,
    now: () => now++,
    disposeSessionBrowser: vi.fn(async () => { calls.push('dispose-browser'); }),
    applyClosedSideEffects: vi.fn(async (_sessionId, options) => {
      calls.push('closed-side-effects');
      options.onClearedBeforeLeave?.();
    }),
    archiveTeamsIfOrphaned: vi.fn(async () => { calls.push('archive-teams'); }),
    unarchiveTeamsForRevivedLead: vi.fn(async () => { calls.push('unarchive-teams'); }),
    leaveTeamsAndAutoArchive: vi.fn(async () => { calls.push('leave-teams'); }),
    revokeHandOffSource: vi.fn(() => { calls.push('revoke-handoff'); }),
    abortHandOffSource: vi.fn(() => { calls.push('abort-handoff'); }),
    restoreHandOffSource: vi.fn(() => { calls.push('restore-handoff'); }),
    reactivateHandOffSource: vi.fn((_sessionId, persist) => {
      calls.push('reactivate-handoff');
      persist();
    }),
    assertDeleteAllowed: vi.fn(() => { calls.push('assert-delete'); }),
    releaseSessionToken: vi.fn(() => { calls.push('release-token'); }),
    publishSessionUpserted: vi.fn(() => { calls.push('publish-upsert'); }),
    publishSessionRemoved: vi.fn(() => { calls.push('publish-removed'); }),
    warn: vi.fn(() => { calls.push('warn'); }),
  };
  return { calls, core: new SessionLifecycleCore(host), host, rows };
}

describe('SessionLifecycleCore', () => {
  it('closes an active session and tracks the structured side-effect barrier', async () => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const context = fixture();
    vi.mocked(context.host.applyClosedSideEffects).mockImplementation(async (_id, options) => {
      options.onClearedBeforeLeave?.();
      await barrier;
    });
    const internal = state();

    context.core.markClosed(internal, 'session-a');
    await Promise.resolve();

    expect(context.rows.get('session-a')).toMatchObject({ lifecycle: 'closed' });
    expect(internal.closeEpoch.get('session-a')).toBe(1);
    expect(context.host.revokeHandOffSource).toHaveBeenCalledWith('session-a');
    expect(context.host.disposeSessionBrowser).toHaveBeenCalledWith('session-a');
    expect(context.host.publishSessionUpserted).toHaveBeenCalledOnce();
    expect(context.core.hasPendingCloseSideEffects('session-a')).toBe(true);

    finish();
    await barrier;
    await Promise.resolve();
    expect(context.core.hasPendingCloseSideEffects('session-a')).toBe(false);
  });

  it('keeps explicit close ordered and degrades an adapter-close failure', async () => {
    const context = fixture();
    const internal = state();
    const close = vi.fn(async () => {
      context.calls.push('adapter-close');
      throw new Error('raw-provider-error');
    });

    await context.core.close('session-a', close, internal);

    expect(context.rows.get('session-a')).toMatchObject({ lifecycle: 'closed' });
    expect(context.calls).toEqual([
      'revoke-handoff',
      'adapter-close',
      'warn',
      'lifecycle:closed:100:true',
      'dispose-browser',
      'closed-side-effects',
      'publish-upsert',
      'release-token',
    ]);
  });

  it('coordinates archive, reactivation, pin, and permission projections through host ports', async () => {
    const context = fixture();

    await context.core.archive('session-a');
    await context.core.unarchive('session-a');
    context.core.reactivate('session-a');
    context.core.setPinned('session-a', true);
    context.core.recordCreatedPermissionMode('session-a', 'plan');
    context.core.recordCreatedPermissionMode('session-a', 'default');
    context.core.notifyTeamMembershipChanged('session-a');

    expect(context.rows.get('session-a')).toMatchObject({
      archivedAt: null,
      lifecycle: 'active',
      pinnedAt: 102,
      permissionMode: 'plan',
    });
    expect(context.host.abortHandOffSource).toHaveBeenCalledOnce();
    expect(context.host.archiveTeamsIfOrphaned).toHaveBeenCalledOnce();
    expect(context.host.unarchiveTeamsForRevivedLead).toHaveBeenCalledOnce();
    expect(context.host.reactivateHandOffSource).toHaveBeenCalledOnce();
    expect(context.host.publishSessionUpserted).toHaveBeenCalledTimes(6);
  });

  it('deletes after exact teardown and fences both application and native identities', async () => {
    const context = fixture();
    const internal = state();
    internal.closeEpoch.set('session-a', 8);
    const close = vi.fn(async () => { context.calls.push('adapter-close'); });

    await context.core.delete(internal, 'session-a', close);

    expect(context.calls).toEqual([
      'assert-delete',
      'revoke-handoff',
      'leave-teams',
      'adapter-close',
      'dispose-browser',
      'delete-row',
      'restore-handoff',
      'publish-removed',
    ]);
    expect(context.rows.has('session-a')).toBe(false);
    expect(internal.closeEpoch.has('session-a')).toBe(false);
    expect(internal.recentlyDeleted.get('session-a')).toBe(100);
    expect(internal.recentlyDeleted.get('cli-a')).toBe(100);
  });
});
