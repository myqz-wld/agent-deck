import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

import {
  SessionManagerFacade,
  type SessionManagerHost,
} from './facade-core';

const session: SessionRecord = {
  id: 'session-a',
  agentId: 'claude-code',
  cwd: '/workspace',
  title: 'workspace',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 1,
  lastEventAt: 1,
  endedAt: null,
  archivedAt: null,
};

const event: AgentEvent = {
  sessionId: session.id,
  agentId: session.agentId,
  kind: 'message',
  payload: { role: 'user' },
  ts: 2,
  source: 'sdk',
};

function makeHost(): SessionManagerHost {
  return {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    hasSdkClaim: vi.fn(() => true),
    expectSdkSession: vi.fn(() => () => undefined),
    ensure: vi.fn(() => session),
    ingest: vi.fn(),
    markRecentlyDeleted: vi.fn(),
    hasPendingCloseSideEffects: vi.fn(() => true),
    runClosedSideEffects: vi.fn(() => Promise.resolve()),
    markClosed: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    getCloseEpoch: vi.fn(() => 7),
    bumpCloseEpoch: vi.fn(),
    forgetCloseEpoch: vi.fn(),
    archive: vi.fn(() => Promise.resolve()),
    unarchive: vi.fn(() => Promise.resolve()),
    unarchiveOnUserSend: vi.fn(() => Promise.resolve()),
    reactivate: vi.fn(),
    setPinned: vi.fn(() => session),
    recordCreatedPermissionMode: vi.fn(),
    notifyTeamMembershipChanged: vi.fn(),
    delete: vi.fn(() => Promise.resolve()),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
    list: vi.fn(() => [session]),
    get: vi.fn(() => session),
    enrichWithTeams: vi.fn(() => session),
    enrichWithTeamsBatch: vi.fn(() => [session]),
  };
}

describe('SessionManagerFacade', () => {
  it('delegates SDK ownership, registration, and event ingress without exposing host state', () => {
    const host = makeHost();
    const facade = new SessionManagerFacade(host);

    facade.claimAsSdk('session-a');
    facade.releaseSdkClaim('session-b');
    expect(facade.hasSdkClaim('session-a')).toBe(true);
    const cancel = facade.expectSdkSession('/workspace', 123);
    expect(facade.ensure('session-a', {
      agentId: 'claude-code',
      source: 'sdk',
    })).toBe(session);
    facade.ingest(event);
    facade.markRecentlyDeleted('session-a', 'native-a');

    expect(host.claimAsSdk).toHaveBeenCalledWith('session-a');
    expect(host.releaseSdkClaim).toHaveBeenCalledWith('session-b');
    expect(host.hasSdkClaim).toHaveBeenCalledWith('session-a');
    expect(host.expectSdkSession).toHaveBeenCalledWith('/workspace', 123);
    expect(cancel).toBeTypeOf('function');
    expect(host.ensure).toHaveBeenCalledWith('session-a', {
      agentId: 'claude-code',
      source: 'sdk',
    });
    expect(host.ingest).toHaveBeenCalledWith(event);
    expect(host.markRecentlyDeleted).toHaveBeenCalledWith('session-a', 'native-a');
  });

  it('returns the exact lifecycle promises and projections supplied by the host', () => {
    const host = makeHost();
    const facade = new SessionManagerFacade(host);
    const sideEffects = facade.runClosedSideEffects('session-a', { logPrefix: 'test' });
    const close = facade.close('session-a');
    const archive = facade.archive('session-a');
    const unarchive = facade.unarchive('session-a');
    const unarchiveOnSend = facade.unarchiveOnUserSend('session-a');
    const deletion = facade.delete('session-a');

    expect(facade.hasPendingCloseSideEffects('session-a')).toBe(true);
    expect(facade.getCloseEpoch('session-a')).toBe(7);
    expect(sideEffects).toBe(vi.mocked(host.runClosedSideEffects).mock.results[0]?.value);
    expect(close).toBe(vi.mocked(host.close).mock.results[0]?.value);
    expect(archive).toBe(vi.mocked(host.archive).mock.results[0]?.value);
    expect(unarchive).toBe(vi.mocked(host.unarchive).mock.results[0]?.value);
    expect(unarchiveOnSend).toBe(vi.mocked(host.unarchiveOnUserSend).mock.results[0]?.value);
    expect(deletion).toBe(vi.mocked(host.delete).mock.results[0]?.value);

    facade.markClosed('session-a');
    facade.bumpCloseEpoch('session-a');
    facade.forgetCloseEpoch('session-a');
    facade.reactivate('session-a');
    expect(facade.setPinned('session-a', true)).toBe(session);
    facade.recordCreatedPermissionMode('session-a', 'acceptEdits');
    facade.notifyTeamMembershipChanged('session-a');

    expect(host.runClosedSideEffects).toHaveBeenCalledWith('session-a', { logPrefix: 'test' });
    expect(host.markClosed).toHaveBeenCalledWith('session-a');
    expect(host.bumpCloseEpoch).toHaveBeenCalledWith('session-a');
    expect(host.forgetCloseEpoch).toHaveBeenCalledWith('session-a');
    expect(host.reactivate).toHaveBeenCalledWith('session-a');
    expect(host.setPinned).toHaveBeenCalledWith('session-a', true);
    expect(host.recordCreatedPermissionMode).toHaveBeenCalledWith('session-a', 'acceptEdits');
    expect(host.notifyTeamMembershipChanged).toHaveBeenCalledWith('session-a');
  });

  it('delegates identity updates, queries, and team projections exactly once', () => {
    const host = makeHost();
    const facade = new SessionManagerFacade(host);

    facade.renameSdkSession('temporary', 'session-a');
    facade.updateCliSessionId('session-a', 'native-a');
    expect(facade.list()).toEqual([session]);
    expect(facade.get('session-a')).toBe(session);
    expect(facade.enrichWithTeams(session)).toBe(session);
    expect(facade.enrichWithTeamsBatch([session])).toEqual([session]);

    expect(host.renameSdkSession).toHaveBeenCalledOnce();
    expect(host.renameSdkSession).toHaveBeenCalledWith('temporary', 'session-a');
    expect(host.updateCliSessionId).toHaveBeenCalledWith('session-a', 'native-a');
    expect(host.list).toHaveBeenCalledOnce();
    expect(host.get).toHaveBeenCalledWith('session-a');
    expect(host.enrichWithTeams).toHaveBeenCalledWith(session);
    expect(host.enrichWithTeamsBatch).toHaveBeenCalledWith([session]);
  });
});
