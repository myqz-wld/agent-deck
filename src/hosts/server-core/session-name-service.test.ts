import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerAccessContext, parseSessionName, type JsonValue } from '@contracts/index';
import type { SessionRecord } from '@shared/types';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import type { ServerCoreMutationIdentity } from './runtime-metadata-store';
import { ServerCoreSessionNameService } from './session-name-service';
import { ServerCoreSessionNameRuntime } from './session-name-runtime';

function setup() {
  const session: SessionRecord = { id: 'work-a', agentId: 'codex-cli', title: 'Workspace',
    cwd: '/workspaces/demo', source: 'sdk', lifecycle: 'dormant', activity: 'finished',
    startedAt: 1, lastEventAt: 2, endedAt: null, archivedAt: null };
  const sessions = { get: (id: string) => id === session.id ? session : null,
    setTitle: vi.fn((_id: string, title: string) => { session.title = title; }) };
  const records = new Map<string, { fingerprint: string; result?: JsonValue; revision?: number }>();
  let revision = 0;
  const metadata: ServerCoreIssueMetadataPort = {
    currentRevision: () => revision,
    appendChange: vi.fn(() => ++revision),
    claimMutation: (input: ServerCoreMutationIdentity) => {
      const prior = records.get(input.idempotencyKey);
      if (!prior) { records.set(input.idempotencyKey, { fingerprint: input.requestFingerprint }); return { state: 'claimed' }; }
      if (prior.fingerprint !== input.requestFingerprint) return { state: 'conflict' };
      return prior.result ? { state: 'completed', result: prior.result, revision: prior.revision! } : { state: 'uncertain' };
    },
    completeMutation: vi.fn((input, result, next) => {
      records.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result, revision: next });
    }),
    releaseMutationClaim: input => { records.delete(input.idempotencyKey); },
  };
  const names = new ServerCoreSessionNameService(sessions, metadata);
  const scope = { connectionScope: 'owner-a', accessSurface: 'feishu' as const, idempotencyKey: 'rename-a' };
  const params = { sessionId: session.id, title: '连接验证', expectedTitle: 'Workspace' };
  return { session, sessions, metadata, names, scope, params };
}

describe('Core session names', () => {
  it('persists a readable name and replays the original result without changing the session runtime', () => {
    const t = setup();
    const before = { ...t.session };
    const first = t.names.update(t.params, t.scope);
    expect(t.names.update(t.params, t.scope)).toEqual(first);
    expect(t.sessions.setTitle).toHaveBeenCalledTimes(1);
    expect(t.session).toEqual({ ...before, title: '连接验证' });
    expect(t.metadata.appendChange).toHaveBeenCalledWith('session.name.updated', 'work-a', { sessionId: 'work-a' });
  });

  it('preserves a newer manual name instead of applying an older automatic suggestion', () => {
    const t = setup();
    t.session.title = '用户指定名称';
    expect(() => t.names.update(t.params, t.scope)).toThrow(/name changed/);
    expect(t.sessions.setTitle).not.toHaveBeenCalled();
    expect(t.session.title).toBe('用户指定名称');
  });

  it('replays a lost command response without undoing a later manual name', () => {
    const t = setup();
    const first = t.names.update(t.params, t.scope);
    t.session.title = '后来的名称';
    expect(t.names.update({ ...t.params, expectedTitle: t.session.title }, t.scope)).toEqual(first);
    expect(t.sessions.setTitle).toHaveBeenCalledTimes(1);
    expect(t.session.title).toBe('后来的名称');
  });

  it('reconciles a committed name after losing its ledger result without repeating the write', () => {
    const t = setup();
    vi.mocked(t.metadata.completeMutation).mockImplementationOnce(() => { throw new Error('Result write lost'); });
    expect(() => t.names.update(t.params, t.scope)).toThrow('Result write lost');
    expect(t.names.update(t.params, t.scope)).toMatchObject({ title: '连接验证' });
    expect(t.sessions.setTitle).toHaveBeenCalledTimes(1);
    expect(() => t.names.update({ ...t.params, title: 'Another' }, t.scope)).toThrow(/identity changed/);
  });

  it.each(['closed', 'archived', 'internal'] as const)('rejects %s targets', state => {
    const t = setup();
    if (state === 'closed') t.session.lifecycle = 'closed';
    if (state === 'archived') t.session.archivedAt = 3;
    if (state === 'internal') t.session.hiddenFromHistory = true;
    expect(() => t.names.update(t.params, t.scope)).toThrow();
    expect(t.sessions.setTitle).not.toHaveBeenCalled();
  });

  it('rejects blank, multiline and oversized UTF-8 names without truncating owner input', () => {
    for (const value of ['', ' ', ' leading', 'two\nlines', '猫'.repeat(171)]) expect(() => parseSessionName(value)).toThrow();
    expect(parseSessionName('猫'.repeat(170))).toHaveLength(170);
  });

  it('enforces the remote owner grant, cancellation and stable mutation key', async () => {
    const t = setup();
    const base = { supportedMethods: [], execute: vi.fn(), start: async () => {}, stop: async () => {},
      currentRevision: () => 0 } as DaemonCoreRuntime;
    const runtime = new ServerCoreSessionNameRuntime(base, t.names);
    const access = issueRemoteOwnerAccessContext({ topology: 'relay',
      instanceId: 'instance-a', clientId: 'client-a', connectionScope: 'owner-a', surface: 'feishu' });
    const input: DaemonRequestInput = { access,
      method: 'session.name.update', params: t.params, idempotencyKey: 'rename-a', expectedRevision: null,
      requestId: 'request-a', deadlineAt: null, signal: new AbortController().signal };
    const denied = { ...access, grant: { ...access.grant, productMethods: [] } };
    await expect(runtime.execute({ ...input, access: denied })).rejects.toMatchObject({ code: 'access_denied' });
    await expect(runtime.execute({ ...input, idempotencyKey: null })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(runtime.execute({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(runtime.execute({ ...input, params: { ...t.params, title: 'two\nlines' } }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(t.sessions.setTitle).not.toHaveBeenCalled();
    expect((await runtime.execute(input)).result).toMatchObject({ title: '连接验证' });
  });
});
