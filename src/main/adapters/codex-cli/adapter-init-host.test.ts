import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(function Bridge(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  getSetting: vi.fn((key: string) => {
    if (key === 'codexCliPath') return '/trusted/codex';
    if (key === 'permissionTimeoutMs') return 12_000;
    return undefined;
  }),
  recoveryContinuationHost: {},
  runtimeHost: {},
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('./sdk-bridge', () => ({
  CodexSdkBridge: mocks.bridge,
}));
vi.mock('@main/session/continuation-context/recovery-host', () => ({
  desktopRecoveryContinuationHost: mocks.recoveryContinuationHost,
}));
vi.mock('./sdk-bridge/runtime-host', () => ({
  desktopCodexBridgeRuntimeHost: mocks.runtimeHost,
}));

describe('desktop Codex adapter init host', () => {
  it('owns both initialization settings and the concrete bridge constructor', async () => {
    const { desktopCodexAdapterInitHost: host } = await import('./adapter-init-host');

    expect(host.readPermissionTimeoutMs()).toBe(12_000);
    expect(host.readCodexCliPath()).toBe('/trusted/codex');
    expect(host.recoveryContinuationHost).toBe(mocks.recoveryContinuationHost);
    expect(host.runtimeHost).toBe(mocks.runtimeHost);
    const options = {
      emit: vi.fn(),
      recoveryContinuationHost: host.recoveryContinuationHost,
      runtimeHost: host.runtimeHost,
    };
    expect(host.createBridge(options)).toMatchObject({ options });
    expect(mocks.getSetting).toHaveBeenNthCalledWith(1, 'permissionTimeoutMs');
    expect(mocks.getSetting).toHaveBeenNthCalledWith(2, 'codexCliPath');
    expect(mocks.bridge).toHaveBeenCalledWith(options);
  });
});
