import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import type { SessionRecord } from '@shared/types';

import { ServerCoreSessionHistoryMutationRuntime } from './session-history-mutation-runtime';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'server-core', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', accessCredentialId: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop-full',
};

function request(
  method: CoreMethod,
  params: JsonObject,
  idempotencyKey = `intent-${method}`,
  access = desktop,
): DaemonRequestInput {
  return {
    access, requestId: `request-${method}`, method, params, idempotencyKey,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
  };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-a', agentId: 'codex-cli', cwd: '/workspaces/repo', title: 'History',
    source: 'sdk', lifecycle: 'closed', activity: 'finished', startedAt: 1,
    lastEventAt: 2, endedAt: 2, archivedAt: null, pinnedAt: null,
    spawnedBy: null, spawnDepth: 0, ...overrides,
  } as SessionRecord;
}

function harness(initial: SessionRecord) {
  let revision = 7;
  let current: SessionRecord | null = initial;
  const claims = new Map<string, {
    identity: ServerCoreMutationIdentity;
    result?: JsonValue;
    revision?: number;
  }>();
  const metadata = {
    claimMutation: vi.fn((identity: ServerCoreMutationIdentity): ServerCoreMutationClaim => {
      const prior = claims.get(identity.idempotencyKey);
      if (!prior) {
        claims.set(identity.idempotencyKey, { identity });
        return { state: 'claimed' };
      }
      if (
        prior.identity.method !== identity.method ||
        prior.identity.requestFingerprint !== identity.requestFingerprint
      ) return { state: 'conflict' };
      if (prior.result === undefined || prior.revision === undefined) return { state: 'uncertain' };
      return { state: 'completed', result: prior.result, revision: prior.revision };
    }),
    completeMutation: vi.fn((
      identity: ServerCoreMutationIdentity,
      result: JsonValue,
      resultRevision: number,
    ) => {
      const claim = claims.get(identity.idempotencyKey);
      if (!claim) throw new Error('missing claim');
      claim.result = result;
      claim.revision = resultRevision;
    }),
    releaseMutationClaim: vi.fn((identity: ServerCoreMutationIdentity) => {
      claims.delete(identity.idempotencyKey);
    }),
    currentRevision: vi.fn(() => revision),
    appendChange: vi.fn(() => ++revision),
  };
  const manager = {
    archive: vi.fn(async () => {
      if (current) current.archivedAt = 10;
      revision += 1;
    }),
    unarchive: vi.fn(async () => {
      if (current) current.archivedAt = null;
      revision += 1;
    }),
    delete: vi.fn(async () => {
      current = null;
      revision += 1;
    }),
  };
  const teams = {
    archive: vi.fn(), countActiveLeads: vi.fn(() => 1),
    findActiveMembershipsBySession: vi.fn(() => []), get: vi.fn(),
    leaveTeam: vi.fn(), unarchive: vi.fn(),
  };
  const base = {
    supportedMethods: ['system.health'], start: vi.fn(), stop: vi.fn(),
    currentRevision: () => revision, execute: vi.fn(),
  } as unknown as DaemonCoreRuntime;
  const runtime = new ServerCoreSessionHistoryMutationRuntime(base, {
    sessions: { get: () => current }, manager, teams, metadata,
  });
  return { manager, metadata, runtime };
}

describe('ServerCoreSessionHistoryMutationRuntime', () => {
  it('archives one revision-bound history row and replays the same intent once', async () => {
    const state = harness(record());
    const input = request('session.archive', {
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 2,
    });
    const first = await state.runtime.execute(input);
    await expect(state.runtime.execute(input)).resolves.toEqual(first);
    expect(first).toEqual({
      result: { sessionId: 'session-a', state: 'archived', revision: 8 },
      revision: 8,
    });
    expect(state.manager.archive).toHaveBeenCalledOnce();
  });

  it('supports unarchive and delete without exposing a provider result', async () => {
    const archived = harness(record({ archivedAt: 9 }));
    await expect(archived.runtime.execute(request('session.unarchive', {
      sessionId: 'session-a', expectedArchived: true, expectedUpdatedAt: 2,
    }))).resolves.toMatchObject({ result: { state: 'unarchived' } });
    expect(archived.manager.unarchive).toHaveBeenCalledOnce();

    const deleted = harness(record());
    await expect(deleted.runtime.execute(request('session.delete', {
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 2,
    }))).resolves.toMatchObject({ result: { state: 'deleted' } });
    expect(deleted.manager.delete).toHaveBeenCalledOnce();
  });

  it('rejects stale row state and releases the claim without mutation', async () => {
    const state = harness(record());
    await expect(state.runtime.execute(request('session.archive', {
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 1,
    }))).rejects.toMatchObject({ code: 'conflict' });
    expect(state.manager.archive).not.toHaveBeenCalled();
    expect(state.metadata.releaseMutationClaim).toHaveBeenCalledOnce();
  });

  it('denies the Feishu surface before claiming an intent', async () => {
    const state = harness(record());
    const feishu = {
      ...desktop, clientId: 'feishu-a', transport: 'feishu' as const,
      surface: 'feishu-session-console' as const,
    };
    await expect(Promise.resolve().then(() => state.runtime.execute(request('session.delete', {
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 2,
    }, 'intent-feishu', feishu)))).rejects.toMatchObject({ code: 'access_denied' });
    expect(state.metadata.claimMutation).not.toHaveBeenCalled();
  });
});
