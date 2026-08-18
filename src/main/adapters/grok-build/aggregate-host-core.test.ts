import { describe, expect, it, vi } from 'vitest';

import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { AdapterContext } from '../types';
import {
  createGrokBuildAdapterHost,
  type GrokBuildAggregateHostOptions,
} from './aggregate-host-core';
import { testGrokBridgeRuntimeHost } from './__tests__/bridge-runtime-fixture';
import { GrokBuildBridge } from './bridge';
import { GROK_HOOK_EVENTS, GrokHookInstaller } from './hook-installer';

function fixture() {
  const sessionManager = {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    delete: vi.fn(async () => undefined),
    markClosed: vi.fn(),
    updateCliSessionId: vi.fn(),
  };
  const settings = {
    readBinaryPath: vi.fn(() => '/trusted/grok'),
    readDefaultSandbox: vi.fn(() => 'workspace'),
    readInjectAgents: vi.fn(() => true),
    readInjectAgentPrompt: vi.fn(() => true),
    readInjectSkills: vi.fn(() => false),
    readMcpEnabled: vi.fn(() => true),
    readMcpHttpEnabled: vi.fn(() => true),
    readPermissionTimeoutMs: vi.fn(() => 12_000),
    readSummaryModel: vi.fn(() => 'fable'),
    readSummaryReasoning: vi.fn(() => 'high'),
  };
  const resources = {
    loadBaselinePrompt: vi.fn(async () => 'rules'),
    preparePluginProfile: vi.fn(async () => '/plugin'),
  };
  const diagnostics = {
    reportStartupCleanupFailure: vi.fn(),
    reportCapabilityProbeSkipped: vi.fn(),
  };
  const options: GrokBuildAggregateHostOptions = {
    runtimeHost: testGrokBridgeRuntimeHost,
    sessionManager,
    settings,
    resources,
    diagnostics,
    hookDiagnostics: new HookRouteDiagnostics(),
    hookInstallerObserver: { statusReadFailed: vi.fn() },
  };
  return { diagnostics, options, resources, sessionManager, settings };
}

describe('Grok aggregate host Core', () => {
  it('constructs an immutable concrete bridge host from explicit ports', async () => {
    const input = fixture();
    const host = createGrokBuildAdapterHost(input.options);
    const bridgeOptions = {
      runtimeHost: testGrokBridgeRuntimeHost,
      emit: vi.fn(),
      sessionManager: input.sessionManager,
      reportStartupCleanupFailure: vi.fn(),
      mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
      isAgentDeckMcpEnabled: () => true,
      getAgentProfilePrompt: async () => null,
      getPluginDirectories: async () => [],
      permissionTimeoutMs: 12_000,
    } as Parameters<typeof host.bridge.createBridge>[0];

    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.bridge)).toBe(true);
    expect(host.bridge.bridgeRuntimeHost).toBe(testGrokBridgeRuntimeHost);
    expect(host.bridge.sessionManager).toBe(input.sessionManager);
    expect(host.bridge.createBridge(bridgeOptions)).toBeInstanceOf(GrokBuildBridge);
    expect(host.bridge.readBinaryPath()).toBe('/trusted/grok');
    expect(host.bridge.readDefaultSandbox()).toBe('workspace');
    await expect(host.bridge.loadBaselinePrompt()).resolves.toBe('rules');
    await expect(
      host.bridge.preparePluginProfile({ includeAgents: true, includeSkills: false }),
    ).resolves.toBe('/plugin');

    const cleanupError = new Error('cleanup');
    host.bridge.reportStartupCleanupFailure('session-a', cleanupError);
    host.reportCapabilityProbeSkipped(cleanupError);
    expect(input.diagnostics.reportStartupCleanupFailure).toHaveBeenCalledWith(
      'session-a',
      cleanupError,
    );
    expect(input.diagnostics.reportCapabilityProbeSkipped).toHaveBeenCalledWith(
      cleanupError,
    );
  });

  it('owns hook construction and registers the exact Grok route surface', async () => {
    const input = fixture();
    const host = createGrokBuildAdapterHost(input.options);
    const registerForAdapter = vi.fn();
    const context: AdapterContext = {
      hookServer: {
        isRunning: true,
        listeningPort: 47_821,
        bearerToken: 'h'.repeat(64),
        mcpBearerToken: 'm'.repeat(64),
      },
      routeRegistry: { registerForAdapter },
      emit: vi.fn(),
      paths: {
        appUserData: '/private/app-data',
        userHome: '/private/home',
        userClaudeSettings: '/private/home/.claude/settings.json',
      },
    };

    expect(host.createHookIntegration(context)).toBeInstanceOf(GrokHookInstaller);
    host.registerHookRoutes(context, 'grok-build');
    expect(registerForAdapter).toHaveBeenCalledTimes(GROK_HOOK_EVENTS.length);
    expect(registerForAdapter.mock.calls.map(([adapterId, route]) => [
      adapterId,
      route.url,
    ])).toEqual(GROK_HOOK_EVENTS.map((event) => [
      'grok-build',
      `/hook/grok/${event.toLowerCase()}`,
    ]));
    await expect(host.summariseEvents('/repo', [])).resolves.toBeNull();
  });
});
