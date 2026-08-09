import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(function Bridge(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  getSetting: vi.fn((key: string) => {
    const values: Record<string, unknown> = {
      enableAgentDeckMcp: true,
      grokCliPath: '/trusted/grok',
      grokSandbox: 'workspace',
      injectAgentDeckGrokAgents: true,
      injectAgentDeckGrokAgentsMd: true,
      injectAgentDeckGrokSkills: false,
      mcpHttpEnabled: true,
      permissionTimeoutMs: 12_000,
    };
    return values[key];
  }),
  loadPrompt: vi.fn(async () => 'rules'),
  prepareProfile: vi.fn(async () => '/plugin'),
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    delete: vi.fn(async () => undefined),
    markClosed: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
  warn: vi.fn(),
  runtimeHost: { name: 'desktop-grok-runtime-host' },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: mocks.sessionManager,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));
vi.mock('./bridge', () => ({ GrokBuildBridge: mocks.bridge }));
vi.mock('./bridge-runtime-host', () => ({
  desktopGrokBridgeRuntimeHost: mocks.runtimeHost,
}));
vi.mock('./resources', () => ({
  loadGrokBaselinePrompt: mocks.loadPrompt,
  prepareGrokPluginProfile: mocks.prepareProfile,
}));

describe('desktop Grok adapter host', () => {
  it('owns settings, resources, and the concrete bridge constructor', async () => {
    const { desktopGrokAdapterHost: host } = await import('./adapter-host');
    const options = { emit: vi.fn() } as unknown as Parameters<
      typeof host.createBridge
    >[0];

    expect(host.createBridge(options)).toMatchObject({ options });
    expect(host.bridgeRuntimeHost).toBe(mocks.runtimeHost);
    expect(host.sessionManager).toBe(mocks.sessionManager);
    const failure = new Error('cleanup');
    host.reportStartupCleanupFailure('session-a', failure);
    expect(mocks.warn).toHaveBeenCalledWith(
      '[grok-build] failed to remove strict-startup session session-a',
      failure,
    );
    expect(host.readBinaryPath()).toBe('/trusted/grok');
    expect(host.readDefaultSandbox()).toBe('workspace');
    expect(host.readInjectAgents()).toBe(true);
    expect(host.readInjectAgentPrompt()).toBe(true);
    expect(host.readInjectSkills()).toBe(false);
    expect(host.readMcpEnabled()).toBe(true);
    expect(host.readMcpHttpEnabled()).toBe(true);
    expect(host.readPermissionTimeoutMs()).toBe(12_000);
    await expect(host.loadBaselinePrompt()).resolves.toBe('rules');
    await expect(
      host.preparePluginProfile({ includeAgents: true, includeSkills: false }),
    ).resolves.toBe('/plugin');
    expect(mocks.bridge).toHaveBeenCalledWith(options);
    expect(mocks.prepareProfile).toHaveBeenCalledWith({
      includeAgents: true,
      includeSkills: false,
    });
  });
});
