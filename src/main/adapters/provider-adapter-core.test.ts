import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext, CodexCreateOpts, GrokCreateOpts } from './types';
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterHost,
} from './claude-code/adapter-core';
import {
  CodexCliAdapter,
  type CodexCliAdapterHost,
} from './codex-cli/adapter-core';
import {
  GrokBuildAdapter,
  type GrokBuildAdapterHost,
} from './grok-build/adapter-core';

const helperMocks = vi.hoisted(() => ({
  createClaudeBridge: vi.fn(),
  createCodexBridge: vi.fn(),
  createGrokBridge: vi.fn(),
  resolveGrokSandbox: vi.fn(),
}));

vi.mock('./claude-code/adapter-init-core', () => ({
  createClaudeAdapterBridgeWithHost: helperMocks.createClaudeBridge,
}));

vi.mock('./codex-cli/adapter-init-core', () => ({
  createCodexAdapterBridgeWithHost: helperMocks.createCodexBridge,
}));

vi.mock('./grok-build/adapter-host-core', () => ({
  createGrokAdapterBridgeWithHost: helperMocks.createGrokBridge,
  resolveGrokCreateSandboxWithHost: helperMocks.resolveGrokSandbox,
}));

function context(): AdapterContext {
  return {
    emit: vi.fn(),
    hookServer: {
      listeningPort: 4312,
      bearerToken: 'test-token',
    },
    paths: {
      appUserData: '/data',
      userHome: '/home/test',
      userClaudeSettings: '/home/test/.claude/settings.json',
    },
    routeRegistry: {},
  } as unknown as AdapterContext;
}

function integration() {
  return {
    install: vi.fn(() => 'installed'),
    uninstall: vi.fn(() => 'uninstalled'),
    status: vi.fn(() => 'ready'),
  };
}

describe('provider adapter Core host injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs Claude through its host and keeps hooks and summaries host-owned', async () => {
    const bridge = {};
    const hooks = integration();
    const ctx = context();
    const host = {
      bridge: { name: 'claude-bridge-host' },
      fork: { name: 'claude-fork-host' },
      createHookIntegration: vi.fn(() => hooks),
      registerHookRoutes: vi.fn(),
      validateForkTarget: vi.fn(),
      summariseEvents: vi.fn(async () => 'claude-summary'),
    } as unknown as ClaudeCodeAdapterHost;
    helperMocks.createClaudeBridge.mockReturnValue(bridge);
    const adapter = new ClaudeCodeAdapter(host);

    await adapter.init(ctx);

    expect(helperMocks.createClaudeBridge).toHaveBeenCalledWith(host.bridge, ctx.emit);
    expect(host.createHookIntegration).toHaveBeenCalledWith(ctx);
    expect(host.registerHookRoutes).toHaveBeenCalledWith(ctx, 'claude-code');
    await expect(adapter.installIntegration({ scope: 'user' })).resolves.toBe('installed');
    await expect(adapter.integrationStatus({ scope: 'project', cwd: '/repo' })).resolves.toBe(
      'ready',
    );
    await expect(adapter.summariseEvents('/repo', [], 'evidence')).resolves.toBe(
      'claude-summary',
    );
    expect(host.summariseEvents).toHaveBeenCalledWith('/repo', [], 'evidence', undefined);
  });

  it('constructs Codex through its host and resolves providers before bridge calls', async () => {
    const bridge = {
      createSession: vi.fn(async () => ({ sessionId: 'codex-session' })),
    };
    const hooks = integration();
    const ctx = context();
    const host = {
      bridge: { name: 'codex-bridge-host' },
      createHookIntegration: vi.fn(() => hooks),
      registerHookRoutes: vi.fn(),
      resolveProvider: vi.fn(() => 'resolved-provider'),
      summariseEvents: vi.fn(async () => 'codex-summary'),
    } as unknown as CodexCliAdapterHost;
    helperMocks.createCodexBridge.mockReturnValue(bridge);
    const adapter = new CodexCliAdapter(host);

    await adapter.init(ctx);
    const sessionId = await adapter.createSession({
      agentId: 'codex-cli',
      cwd: '/repo',
      prompt: 'continue',
      provider: 'configured-provider',
    } as CodexCreateOpts & { agentId: 'codex-cli' });

    expect(sessionId).toBe('codex-session');
    expect(helperMocks.createCodexBridge).toHaveBeenCalledWith(
      host.bridge,
      ctx.emit,
      ctx.hookServer,
    );
    expect(host.resolveProvider).toHaveBeenCalledWith('configured-provider');
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'resolved-provider' }),
    );
    expect(host.registerHookRoutes).toHaveBeenCalledWith(ctx, 'codex-cli');
  });

  it('keeps Grok probing, sandbox resolution, and diagnostics behind its host', async () => {
    const probeFailure = new Error('probe unavailable');
    const bridge = {
      probeCapabilities: vi.fn(async () => {
        throw probeFailure;
      }),
      createSession: vi.fn(async () => 'grok-session'),
    };
    const hooks = integration();
    const ctx = context();
    const host = {
      bridge: { name: 'grok-bridge-host' },
      createHookIntegration: vi.fn(() => hooks),
      registerHookRoutes: vi.fn(),
      reportCapabilityProbeSkipped: vi.fn(),
      summariseEvents: vi.fn(async () => 'grok-summary'),
    } as unknown as GrokBuildAdapterHost;
    helperMocks.createGrokBridge.mockReturnValue(bridge);
    helperMocks.resolveGrokSandbox.mockReturnValue('workspace');
    const adapter = new GrokBuildAdapter(host);

    await adapter.init(ctx);
    const sessionId = await adapter.createSession({
      agentId: 'grok-build',
      cwd: '/repo',
      prompt: 'continue',
    } as GrokCreateOpts & { agentId: 'grok-build' });

    expect(sessionId).toBe('grok-session');
    expect(helperMocks.createGrokBridge).toHaveBeenCalledWith(
      host.bridge,
      ctx.emit,
      'http://127.0.0.1:4312/mcp',
      expect.any(Function),
    );
    expect(bridge.probeCapabilities).toHaveBeenCalledWith('/home/test');
    expect(host.reportCapabilityProbeSkipped).toHaveBeenCalledWith(probeFailure);
    expect(helperMocks.resolveGrokSandbox).toHaveBeenCalledWith(
      host.bridge,
      undefined,
      undefined,
    );
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ grokSandbox: 'workspace' }),
    );
    expect(host.registerHookRoutes).toHaveBeenCalledWith(ctx, 'grok-build');
  });
});
