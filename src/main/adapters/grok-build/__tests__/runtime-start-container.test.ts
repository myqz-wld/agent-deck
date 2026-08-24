import { methods } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { GrokCreateOpts } from '@main/adapters/types';
import type { GrokAcpSession } from '../acp-process';
import { createGrokRuntime } from '../runtime-factory';
import { startGrokRuntime, type GrokRuntimeStartContext } from '../runtime-start';
import type { GrokRuntime } from '../runtime-types';
import { testGrokBridgeRuntimeHost } from './bridge-runtime-fixture';

describe('Grok Provider-container runtime start', () => {
  it('uses container cwd while suppressing unreachable MCP and host plugin paths', async () => {
    const runtime = createGrokRuntime('application-session', {
      cwd: '/host/workspace/repo',
      grokSandbox: 'workspace',
      grokAgentName: 'reviewer-grok',
      grokAgentSource: 'plugin',
      grokPluginDir: '/host/private/plugin',
      model: 'grok-4.5',
    } as GrokCreateOpts, null);
    const request = vi.fn(async (method: unknown) => {
      if (method === methods.agent.session.new) {
        return {
          sessionId: 'native-session',
          models: { currentModelId: 'grok-4.5', availableModels: [] },
          modes: { currentModeId: 'default', availableModes: [] },
        };
      }
      return { result: null };
    });
    const process = {
      authenticatedMethodId: 'xai.api_key',
      connection: { agent: { request, notify: vi.fn() } },
      diagnostics: '',
      initializeResponse: {
        agentCapabilities: { loadSession: true },
        _meta: { modelState: { currentModelId: 'grok-4.5' } },
      },
      isStopping: false,
      onExit: vi.fn(),
      pid: null,
      stop: vi.fn(async () => undefined),
      usedLoginShell: false,
    } as unknown as GrokAcpSession;
    const processFactory = vi.fn(async () => ({
      allowAgentDeckMcp: false,
      allowHostPathMetadata: false,
      process,
      sessionCwd: '/workspace/repo',
    }));
    const runtimes = new Map<string, GrokRuntime>([[runtime.applicationSessionId, runtime]]);
    const context = {
      sessionManager: { updateCliSessionId: vi.fn() },
      runtimeHost: testGrokBridgeRuntimeHost,
      binaryPath: '/host/native/grok-must-not-run',
      runtimes,
      sessionSetup: {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => true,
        getAgentProfilePrompt: async () => '# safe rules',
        getPluginDirectories: async () => ['/host/private/plugin'],
      },
      permissionController: { handle: vi.fn() },
      emit: vi.fn(),
      emitError: vi.fn(),
      isCurrentRuntime: (candidate: GrokRuntime) => candidate === runtime,
      requireNativeSession: () => 'native-session',
      confirmPromptAccepted: vi.fn(),
      observeModelActivity: vi.fn(),
      observePromptComplete: vi.fn(),
      drain: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      processFactory,
    } as unknown as GrokRuntimeStartContext;

    await expect(startGrokRuntime(runtime, context)).resolves.toBe(true);
    expect(processFactory).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: 'application-session',
      cwd: '/host/workspace/repo',
      sandboxProfile: 'workspace',
    }));
    expect(request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/workspace/repo',
      mcpServers: [],
      _meta: {
        rules: '# safe rules',
        agentProfile: 'reviewer-grok',
        modelId: 'grok-4.5',
      },
    });
    expect(JSON.stringify(request.mock.calls)).not.toContain('/host/private/plugin');
    expect(runtime.cwd).toBe('/host/workspace/repo');
    expect(runtime.activeGrokSandbox).toBe('workspace');
  });
});
