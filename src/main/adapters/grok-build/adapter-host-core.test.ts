import { describe, expect, it, vi } from 'vitest';
import {
  createGrokAdapterBridgeWithHost,
  resolveGrokCreateSandboxWithHost,
  type GrokAdapterHost,
} from './adapter-host-core';
import { testGrokBridgeRuntimeHost } from './__tests__/bridge-runtime-fixture';

function makeHost() {
  const calls: string[] = [];
  let options: Parameters<GrokAdapterHost<Bridge>['createBridge']>[0] | null = null;
  const bridge: Bridge = { probeCapabilities: vi.fn(async () => true) };
  const sessionManager = {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    delete: vi.fn(async () => undefined),
    markClosed: vi.fn(),
    updateCliSessionId: vi.fn(),
  };
  const host: GrokAdapterHost<Bridge> = {
    bridgeRuntimeHost: testGrokBridgeRuntimeHost,
    sessionManager,
    createBridge: vi.fn((value) => {
      calls.push('create');
      options = value;
      return bridge;
    }),
    reportStartupCleanupFailure: vi.fn(),
    loadBaselinePrompt: vi.fn(async () => 'rules'),
    preparePluginProfile: vi.fn(async () => '/bundled/plugin'),
    readBinaryPath: vi.fn(() => {
      calls.push('read-binary');
      return '/trusted/grok';
    }),
    readDefaultSandbox: vi.fn(() => 'workspace'),
    readInjectAgents: vi.fn(() => true),
    readInjectAgentPrompt: vi.fn(() => true),
    readInjectSkills: vi.fn(() => true),
    readMcpEnabled: vi.fn(() => true),
    readMcpHttpEnabled: vi.fn(() => true),
    readPermissionTimeoutMs: vi.fn(() => {
      calls.push('read-timeout');
      return 12_000;
    }),
  };
  return { bridge, calls, host, options: () => options!, sessionManager };
}

interface Bridge {
  probeCapabilities(cwd: string): Promise<boolean>;
}

describe('Grok adapter host Core', () => {
  it('constructs once after static settings and keeps dynamic injection callbacks', async () => {
    const fixture = makeHost();
    const emit = vi.fn();
    const capability = vi.fn();

    expect(
      createGrokAdapterBridgeWithHost(
        fixture.host,
        emit,
        'http://127.0.0.1:1234/mcp',
        capability,
      ),
    ).toBe(fixture.bridge);
    expect(fixture.calls).toEqual(['read-timeout', 'read-binary', 'create']);
    expect(fixture.options()).toMatchObject({
      emit,
      runtimeHost: testGrokBridgeRuntimeHost,
      sessionManager: fixture.sessionManager,
      mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
      onNegotiatedImageCapability: capability,
      permissionTimeoutMs: 12_000,
      binaryPath: '/trusted/grok',
    });
    const failure = new Error('cleanup');
    fixture.options().reportStartupCleanupFailure('session-a', failure);
    expect(fixture.host.reportStartupCleanupFailure).toHaveBeenCalledWith(
      'session-a',
      failure,
    );
    await expect(fixture.options().getAgentProfilePrompt()).resolves.toBe('rules');
    await expect(
      fixture.options().getPluginDirectories({
        requiresAgent: true,
        agentSource: 'bundled',
        agentPluginDir: '/custom/plugin',
      }),
    ).resolves.toEqual(['/custom/plugin', '/bundled/plugin']);
    expect(fixture.host.readInjectAgents).not.toHaveBeenCalled();
    expect(fixture.options().isAgentDeckMcpEnabled()).toBe(true);
  });

  it('preserves disabled short circuits and create-time sandbox precedence', async () => {
    const fixture = makeHost();
    fixture.host.readMcpEnabled = vi.fn(() => false);
    fixture.host.readInjectAgentPrompt = vi.fn(() => false);
    createGrokAdapterBridgeWithHost(fixture.host, vi.fn(), 'http://mcp', vi.fn());

    expect(fixture.options().isAgentDeckMcpEnabled()).toBe(false);
    expect(fixture.host.readMcpHttpEnabled).not.toHaveBeenCalled();
    await expect(fixture.options().getAgentProfilePrompt()).resolves.toBeNull();
    expect(fixture.host.loadBaselinePrompt).not.toHaveBeenCalled();
    expect(resolveGrokCreateSandboxWithHost(fixture.host, null, undefined)).toBeNull();
    expect(resolveGrokCreateSandboxWithHost(fixture.host, undefined, 'resume-id')).toBeUndefined();
    expect(resolveGrokCreateSandboxWithHost(fixture.host, undefined, undefined)).toBe('workspace');
    expect(fixture.host.readDefaultSandbox).toHaveBeenCalledOnce();
  });
});
