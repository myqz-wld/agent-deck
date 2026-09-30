import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueRemoteOwnerAccessContext, type JsonValue } from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import { FileFeishuAssistantStore } from './feishu-assistant-store';
import { ServerCoreFeishuAssistantsRuntime } from './feishu-assistants-runtime';
import { mcpTestSession } from './mcp-server.test-fixture';

function harness() {
  let ids: string[] = []; let revision = 0;
  const claims = new Map<string, { fingerprint: string; result?: JsonValue; revision?: number }>();
  const metadata: ServerCoreIssueMetadataPort = {
    currentRevision: () => revision, appendChange: vi.fn(() => ++revision),
    claimMutation: identity => {
      const row = claims.get(identity.idempotencyKey);
      if (!row) { claims.set(identity.idempotencyKey, { fingerprint: identity.requestFingerprint }); return { state: 'claimed' }; }
      if (row.fingerprint !== identity.requestFingerprint) return { state: 'conflict' };
      return row.result ? { state: 'completed', result: row.result, revision: row.revision! } : { state: 'uncertain' };
    },
    completeMutation: (identity, result, value) => { claims.set(identity.idempotencyKey,
      { fingerprint: identity.requestFingerprint, result, revision: value }); },
    releaseMutationClaim: identity => { claims.delete(identity.idempotencyKey); },
  };
  const records = new Map(['assistant', 'old-chat', 'work'].map(id => [id, {
    ...mcpTestSession(id, '/workspace', id === 'old-chat' ? 'closed' : 'dormant'),
    codexApprovalPolicy: 'never' as const, model: 'selected-model',
  }]));
  const store = { read: () => [...ids], write: vi.fn((next: readonly string[]) => { ids = [...next]; }) };
  const base: DaemonCoreRuntime = { supportedMethods: [], start: async () => {}, stop: async () => {},
    currentRevision: () => revision, execute: vi.fn(async () => ({ result: {}, revision })) };
  const runtime = new ServerCoreFeishuAssistantsRuntime(base, store, metadata, { get: id => records.get(id) ?? null });
  const request = (sessionIds = ['assistant'], idempotencyKey = 'registration-a'): DaemonRequestInput => ({
    method: 'feishu.assistants.register', params: { sessionIds }, idempotencyKey, requestId: idempotencyKey,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
    access: issueRemoteOwnerAccessContext({ topology: 'relay', instanceId: 'instance-a', clientId: 'client-a',
      surface: 'feishu', connectionScope: 'credential-a' }),
  });
  return { records, store, metadata, runtime, request };
}

describe('Feishu owner assistant registration', () => {
  it('reconciles existing and closed assistant identities, skips deleted ids, and replays without touching sessions', async () => {
    const t = harness(); const before = structuredClone([...t.records]);
    const input = t.request(['old-chat', 'deleted-chat', 'assistant']);
    const first = await t.runtime.execute(input);
    expect(first.result).toEqual({ registeredSessionIds: ['assistant', 'old-chat'], revision: 1 });
    expect(await t.runtime.execute(input)).toEqual(first);
    expect(t.store.write).toHaveBeenCalledTimes(1);
    expect([...t.records]).toEqual(before);
    expect(t.store.read()).not.toContain('work');
  });

  it('denies Desktop, missing grants, malformed input and changed idempotency before altering purpose', async () => {
    const t = harness();
    const desktop = issueRemoteOwnerAccessContext({ topology: 'relay', instanceId: 'instance-a', clientId: 'client-a',
      surface: 'desktop', connectionScope: 'credential-a' });
    await expect(t.runtime.execute({ ...t.request(), access: desktop })).rejects.toMatchObject({ code: 'access_denied' });
    const denied = t.request();
    if (denied.access.kind !== 'authenticated-client') throw new Error('fixture');
    await expect(t.runtime.execute({ ...denied, access: { ...denied.access,
      grant: { ...denied.access.grant, channelMethods: [] } } })).rejects.toMatchObject({ code: 'access_denied' });
    await expect(t.runtime.execute({ ...t.request(), params: { sessionIds: ['assistant'], prompt: 'synthetic' } }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(t.store.write).not.toHaveBeenCalled();
    await t.runtime.execute(t.request());
    await expect(t.runtime.execute(t.request(['work']))).rejects.toMatchObject({ code: 'conflict' });
    expect(t.store.read()).toEqual(['assistant']);
  });

  it('safely reconciles a lost durable-write acknowledgement without a second write or provider action', async () => {
    const t = harness(); const write = t.store.write.getMockImplementation()!;
    t.store.write.mockImplementationOnce(next => { write(next); throw new Error('directory fsync failed'); });
    await expect(t.runtime.execute(t.request())).rejects.toThrow('fsync');
    expect((await t.runtime.execute(t.request())).result).toMatchObject({ registeredSessionIds: ['assistant'] });
    expect(t.store.write).toHaveBeenCalledTimes(1);
  });
});

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('private assistant identity persistence', () => {
  it('survives restart and rejects corrupt, broad-readable or symlinked metadata', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'deck-assistant-'))); temporary.push(root);
    const store = new FileFeishuAssistantStore(root); const path = join(root, 'feishu-assistant-identities.json');
    expect(store.read()).toEqual([]); store.write(['assistant']);
    expect(new FileFeishuAssistantStore(root).read()).toEqual(['assistant']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644); expect(() => store.read()).toThrow('Untrusted');
    chmodSync(path, 0o600); writeFileSync(path, '{broken'); expect(() => store.read()).toThrow(); rmSync(path);
    const target = join(root, 'target'); writeFileSync(target, 'untouched'); symlinkSync(target, path);
    expect(() => store.read()).toThrow('Untrusted'); expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
});
