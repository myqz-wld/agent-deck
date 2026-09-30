import { describe, expect, it, vi } from 'vitest';
import { defaultFeishuModelPreference } from '@contracts/index';
import { RemoteHostFeishuPreferencesController } from './service-feishu-preferences';
import { parseRemoteHostFeishuPreferencesUpdate } from './input-validation-feishu-preferences';
import type { RemoteHostScopedClient } from './service-scope';

describe('Feishu settings IPC scope', () => {
  const request = { profileId: 'remote-a', purpose: 'session' as const,
    preference: { ...defaultFeishuModelPreference(), adapterId: 'codex-cli' as const }, expectedSettingsRevision: 4,
    expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 }, intentId: 'choice-1' };
  it('rejects extra fields, native runtime controls and incomplete authority before transport', () => {
    expect(parseRemoteHostFeishuPreferencesUpdate(request)).toEqual(request);
    for (const input of [{ ...request, unexpected: true }, { ...request, expectedAuthority: {} },
      { ...request, preference: { ...request.preference, approvalPolicy: 'never' } }]) {
      expect(() => parseRemoteHostFeishuPreferencesUpdate(input)).toThrow();
    }
  });
  it('passes the expected Core authority and stable intent to the mutation fence', async () => {
    const clientRequest = vi.fn(async () => ({ conversation: defaultFeishuModelPreference(), session: request.preference,
      settingsRevision: 5, revision: 10 }));
    const scoped = vi.fn(async (_profileId: string, _method: string, run: (scope: RemoteHostScopedClient) => Promise<unknown>) =>
      run({ client: { request: clientRequest } } as unknown as RemoteHostScopedClient));
    const controller = new RemoteHostFeishuPreferencesController(scoped as never, (operation, profile, intent) => `${operation}:${profile}:${intent}`);
    await controller.update(request);
    expect(scoped).toHaveBeenCalledWith('remote-a', 'feishu.preferences.update', expect.any(Function), [], request.expectedAuthority);
    expect(clientRequest).toHaveBeenCalledWith('feishu.preferences.update', { purpose: 'session', preference: request.preference,
      expectedSettingsRevision: 4 }, { deadlineMs: expect.any(Number), idempotencyKey: 'feishu-preferences-update:remote-a:choice-1' });
  });
});
