import { mkdtempSync, chmodSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFeishuModelPreference, issueRemoteOwnerAccessContext, type FeishuPreferences,
  type JsonObject, type JsonValue } from '@contracts/index';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import { FileFeishuPreferenceStore } from './feishu-preference-store';
import { ServerCoreFeishuPreferencesRuntime } from './feishu-preferences-runtime';
import type { ServerCoreIssueMetadataPort } from './issue-runtime';
import type { ServerCoreMutationIdentity } from './runtime-metadata-store';

function initial(): FeishuPreferences {
  return { conversation: defaultFeishuModelPreference(), session: defaultFeishuModelPreference(), settingsRevision: 0 };
}
const choice = { adapterId: 'codex-cli' as const, provider: '', model: 'custom-model', thinking: 'high' };
function harness() {
  let value = initial();
  let revision = 1;
  const claims = new Map<string, { identity: ServerCoreMutationIdentity; result?: JsonValue; revision?: number }>();
  const metadata: ServerCoreIssueMetadataPort = {
    currentRevision: () => revision,
    appendChange: vi.fn(() => ++revision),
    claimMutation: (identity) => {
      const previous = claims.get(identity.idempotencyKey);
      if (previous) {
        if (previous.identity.requestFingerprint !== identity.requestFingerprint) return { state: 'conflict' };
        if (previous.result !== undefined) return { state: 'completed', result: previous.result, revision: previous.revision! };
        return { state: 'uncertain' };
      }
      claims.set(identity.idempotencyKey, { identity }); return { state: 'claimed' };
    },
    completeMutation: (identity, result, next) => { claims.set(identity.idempotencyKey, { identity, result, revision: next }); },
    releaseMutationClaim: (identity) => { claims.delete(identity.idempotencyKey); },
  };
  const base: DaemonCoreRuntime = { start: async () => {}, stop: async () => {}, currentRevision: () => revision,
    supportedMethods: [], execute: vi.fn(async () => ({ result: {}, revision })) };
  const capabilities = { describe: vi.fn(async () => sessionConsoleCapabilitiesFixture()) };
  const store = { read: () => structuredClone(value), write: vi.fn((next: FeishuPreferences) => { value = structuredClone(next); }) };
  const runtime = new ServerCoreFeishuPreferencesRuntime(base, store, metadata, capabilities);
  const request = (params: JsonObject, key = 'selection-a'): DaemonRequestInput => ({
    access: issueRemoteOwnerAccessContext({ topology: 'full', instanceId: 'instance-a', clientId: 'client-a',
      surface: 'feishu', connectionScope: 'credential-a' }), method: 'feishu.preferences.update', params,
    idempotencyKey: key, expectedRevision: null, deadlineAt: null, requestId: key, signal: new AbortController().signal,
  });
  return { runtime, store, metadata, capabilities, request };
}

describe('Core-owned Feishu selections', () => {
  it('keeps the two last choices separate and replays a committed mutation without writing again', async () => {
    const t = harness();
    const request = t.request({ purpose: 'conversation', preference: choice, expectedSettingsRevision: 0 });
    const first = await t.runtime.execute(request);
    expect(first.result).toMatchObject({ conversation: choice, session: defaultFeishuModelPreference(), settingsRevision: 1 });
    expect(await t.runtime.execute(request)).toEqual(first);
    expect(t.store.write).toHaveBeenCalledTimes(1);
    await expect(t.runtime.execute(t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 }, 'other')))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(t.store.read().session.adapterId).toBeNull();
  });
  it('uses a settings revision independent of provider activity and never falls back from a disabled adapter', async () => {
    const t = harness(); t.metadata.appendChange('event.persisted', null, {});
    const caps = sessionConsoleCapabilitiesFixture();
    t.capabilities.describe.mockResolvedValueOnce({ ...caps, create: { ...caps.create, enabled: false } });
    await expect(t.runtime.execute(t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 })))
      .rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(t.store.write).not.toHaveBeenCalled();
    await t.runtime.execute(t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 }));
    expect(t.store.read().session).toEqual(choice);
  });
  it('fences stale concurrent saves after awaiting live capability validation', async () => {
    const t = harness();
    const requests = [t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 }, 'a'),
      t.request({ purpose: 'conversation', preference: choice, expectedSettingsRevision: 0 }, 'b')];
    const results = await Promise.allSettled(requests.map(input => t.runtime.execute(input)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(t.store.write).toHaveBeenCalledTimes(1);
  });
  it('does not clear an uncertain claim when publication fails after the file is written', async () => {
    const t = harness();
    vi.mocked(t.metadata.appendChange).mockImplementationOnce(() => { throw new Error('publication failed'); });
    const input = t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 });
    await expect(t.runtime.execute(input)).rejects.toThrow('publication failed');
    await expect(t.runtime.execute(input)).rejects.toMatchObject({ code: 'provider_lost' });
    expect(t.store.write).toHaveBeenCalledTimes(1);
    expect(t.runtime.snapshot().session).toEqual(choice);
  });
  it('rejects extra fields, non-owner scope and invalid adapter-specific choices', async () => {
    const t = harness();
    await expect(t.runtime.execute(t.request({ purpose: 'session', preference: { ...choice, secret: 'synthetic' }, expectedSettingsRevision: 0 })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    const input = t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 });
    const denied = { ...input, access: { ...input.access, kind: 'local-desktop' } as unknown as DaemonRequestInput['access'] };
    await expect(t.runtime.execute(denied)).rejects.toMatchObject({ code: 'access_denied' });
    await expect(t.runtime.execute(t.request({ purpose: 'session', preference: { ...choice, thinking: 'imaginary' }, expectedSettingsRevision: 0 })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(t.store.write).not.toHaveBeenCalled();
  });
  it('retains an uncertain claim when the file replacement succeeds but its durability check fails', async () => {
    const t = harness(); const write = t.store.write.getMockImplementation()!;
    t.store.write.mockImplementationOnce((next) => { write(next); throw new Error('directory fsync failed'); });
    const input = t.request({ purpose: 'session', preference: choice, expectedSettingsRevision: 0 });
    await expect(t.runtime.execute(input)).rejects.toThrow('directory fsync failed');
    await expect(t.runtime.execute(input)).rejects.toMatchObject({ code: 'provider_lost' });
    expect(t.store.read().session).toEqual(choice);
    expect(t.store.write).toHaveBeenCalledTimes(1);
  });
});

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('private preference persistence', () => {
  function directory() { const value = realpathSync(mkdtempSync(join(tmpdir(), 'deck-preferences-'))); temporary.push(value); return value; }
  it('survives reopening and stores only bounded model choices with owner-only permissions', () => {
    const root = directory(); const store = new FileFeishuPreferenceStore(root);
    expect(store.read()).toEqual(initial());
    store.write({ ...initial(), conversation: choice, settingsRevision: 1 });
    expect(new FileFeishuPreferenceStore(root).read().conversation).toEqual(choice);
    expect(statSync(join(root, 'feishu-model-preferences.json')).mode & 0o777).toBe(0o600);
  });
  it('rejects corrupt, broad-readable and symlinked files without touching their targets', () => {
    const root = directory(); const path = join(root, 'feishu-model-preferences.json');
    const store = new FileFeishuPreferenceStore(root);
    store.write(initial()); chmodSync(path, 0o644);
    expect(() => store.read()).toThrow('Untrusted preference file');
    chmodSync(path, 0o600); writeFileSync(path, '{broken');
    expect(() => store.read()).toThrow(); rmSync(path);
    const target = join(root, 'target'); writeFileSync(target, 'unchanged'); symlinkSync(target, path);
    expect(() => store.read()).toThrow('Untrusted preference file');
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });
});
