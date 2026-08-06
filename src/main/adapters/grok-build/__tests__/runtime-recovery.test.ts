import { beforeEach, describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';

import type { GrokCreateOpts } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import type { GrokAcpProcess } from '../acp-process';
import { GROK_SESSION_INFO_METHOD } from '../context-usage';
import type { GrokRuntimeStartContext } from '../runtime-start';
import type { GrokRuntime } from '../runtime-types';

const acpStartMock = vi.hoisted(() => vi.fn());
const resolveGrokBinaryMock = vi.hoisted(() => vi.fn(async () => '/fake/grok'));
const updateCliSessionIdMock = vi.hoisted(() => vi.fn());
const sessionRepoMock = vi.hoisted(() => ({
  setAgentRuntimeProfile: vi.fn(),
  setRuntimeProvider: vi.fn(),
  setModel: vi.fn(),
  setThinking: vi.fn(),
  setSessionMode: vi.fn(),
  setGrokSandbox: vi.fn(),
  setGrokUsageWatermark: vi.fn(),
  get: vi.fn(),
}));
const transactionMock = vi.hoisted(() => vi.fn());
const publishSessionUpdatedMock = vi.hoisted(() => vi.fn());

vi.mock('../acp-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../acp-process')>();
  return {
    ...actual,
    GrokAcpProcess: { start: acpStartMock },
  };
});
vi.mock('../resolve-grok-binary', () => ({
  resolveGrokBinary: resolveGrokBinaryMock,
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: { updateCliSessionId: updateCliSessionIdMock },
}));

import {
  createGrokRuntime,
  persistGrokRuntimeMetadata,
  persistGrokUsageWatermark,
  recoverGrokRuntime,
} from '../runtime-factory';
import {
  startGrokRuntime,
  startGrokRuntimeInBackground,
} from '../runtime-start';
import { createTestGrokBridgeRuntimeHost } from './bridge-runtime-fixture';

const runtimeHost = createTestGrokBridgeRuntimeHost({
  records: sessionRepoMock,
  transaction: (operation) => {
    transactionMock(operation);
    return operation();
  },
  publishSessionUpdated: publishSessionUpdatedMock,
});

function makeRecord(): SessionRecord {
  return {
    id: 'app-grok',
    agentId: 'grok-build',
    cwd: '/repo',
    title: 'Grok review',
    source: 'sdk',
    lifecycle: 'dormant',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    cliSessionId: 'native-grok',
    model: 'grok-4.5',
    thinking: 'xhigh',
    sessionMode: 'plan',
    grokSandbox: 'strict',
    agentProfileName: 'reviewer-grok',
    agentProfileSource: 'plugin',
    agentPluginDir: '/plugins/reviewer-grok',
  };
}

describe('Grok runtime recovery profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the stored Agent and Plugin root through ACP session/load', async () => {
    const record = makeRecord();
    const runtime = recoverGrokRuntime(record);
    const request = vi.fn(async () => ({}));
    const process = {
      connection: { agent: { request, notify: vi.fn() } },
      initializeResponse: {
        agentCapabilities: { loadSession: true },
      },
      onExit: vi.fn(),
      stop: vi.fn(async () => undefined),
      isStopping: false,
      diagnostics: '',
    } as unknown as GrokAcpProcess;
    acpStartMock.mockResolvedValue(process);
    const getPluginDirectories = vi.fn(async () => ['/plugins/reviewer-grok']);
    const observePromptComplete = vi.fn();
    const runtimes = new Map([[runtime.applicationSessionId, runtime]]);
    const context = {
      sessionManager: { updateCliSessionId: updateCliSessionIdMock },
      runtimeHost,
      binaryPath: null,
      runtimes,
      sessionSetup: {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => false,
        getAgentProfilePrompt: async () => '# restored rules',
        getPluginDirectories,
      },
      permissionController: { handle: vi.fn() },
      emit: vi.fn(),
      emitError: vi.fn(),
      isCurrentRuntime: (candidate) => candidate === runtime,
      requireNativeSession: () => 'native-grok',
      confirmPromptAccepted: vi.fn(),
      observePromptComplete,
      drain: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as GrokRuntimeStartContext;

    await expect(startGrokRuntime(runtime, context)).resolves.toBe(true);
    expect(acpStartMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxProfile: 'strict' }),
    );

    expect(getPluginDirectories).toHaveBeenCalledWith({
      requiresAgent: true,
      agentSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });
    expect(request).toHaveBeenCalledWith(methods.agent.session.load, {
      sessionId: 'native-grok',
      cwd: '/repo',
      mcpServers: [],
      _meta: {
        rules: '# restored rules',
        agentProfile: 'reviewer-grok',
        pluginDirs: ['/plugins/reviewer-grok'],
        modelId: 'grok-4.5',
        reasoningEffort: 'xhigh',
      },
    });
    expect(runtime.nativeDefaultModel).toBeNull();
    expect(runtime.runtimeIdentity).toBeNull();

    const startOptions = acpStartMock.mock.calls[0]![0] as {
      onGrokExtensionUpdate: (notification: {
        sessionId: string;
        update: {
          sessionUpdate: string;
          prompt_id: string;
          stop_reason: string;
        };
        _meta: { agentTimestampMs: number };
      }) => void;
      onGrokPromptComplete: (notification: {
        sessionId: string;
        stopReason: string;
        turnId: number;
      }) => void;
    };
    const terminal = {
      sessionId: 'native-grok',
      stopReason: 'end_turn',
      turnId: 7,
    };
    startOptions.onGrokPromptComplete(terminal);
    expect(observePromptComplete).toHaveBeenCalledWith(runtime, terminal);

    const extensionTerminal = {
      sessionId: 'native-grok',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'provider-prompt',
        stop_reason: 'rate_limit',
      },
      _meta: { agentTimestampMs: Date.now() },
    };
    startOptions.onGrokExtensionUpdate(extensionTerminal);
    expect(observePromptComplete).toHaveBeenLastCalledWith(
      runtime,
      extensionTerminal,
    );
  });

  it('restores profile fields for explicit resume and persists them atomically', () => {
    const record = makeRecord();
    const runtime = createGrokRuntime(
      record.id,
      { cwd: record.cwd, resume: record.id } as GrokCreateOpts,
      record,
    );
    sessionRepoMock.get.mockReturnValue(record);

    persistGrokRuntimeMetadata(runtime, runtimeHost);

    expect(runtime).toMatchObject({
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });
    expect(sessionRepoMock.setAgentRuntimeProfile).toHaveBeenCalledWith(record.id, {
      agentProfileName: 'reviewer-grok',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-grok',
    });
    expect(sessionRepoMock.setGrokSandbox).toHaveBeenCalledWith(record.id, 'strict');
  });

  it('persists null overrides instead of coercing the effective native model into DB', () => {
    const runtime = recoverGrokRuntime(makeRecord());
    runtime.model = 'native-default';
    runtime.modelOverride = null;
    runtime.thinking = null;
    runtime.thinkingOverride = null;
    sessionRepoMock.get.mockReturnValue(makeRecord());

    persistGrokRuntimeMetadata(runtime, runtimeHost);

    expect(sessionRepoMock.setRuntimeProvider).toHaveBeenCalledWith(
      runtime.applicationSessionId,
      null,
    );
    expect(sessionRepoMock.setModel).toHaveBeenCalledWith(
      runtime.applicationSessionId,
      null,
    );
    expect(sessionRepoMock.setThinking).toHaveBeenCalledWith(
      runtime.applicationSessionId,
      null,
    );
    expect(transactionMock).toHaveBeenCalled();
  });

  it('restores and persists the cumulative usage watermark across recovery', () => {
    const watermark = {
      totalTokens: 120,
      inputTokens: 90,
      outputTokens: 30,
      thoughtTokens: 6,
      cachedReadTokens: 20,
      cachedWriteTokens: null,
    };
    const record = { ...makeRecord(), grokUsageWatermark: watermark };
    const runtime = recoverGrokRuntime(record);

    expect(runtime.translation).toMatchObject({
      lastUsage: watermark,
    });

    persistGrokUsageWatermark(runtime, runtimeHost);
    expect(sessionRepoMock.setGrokUsageWatermark).toHaveBeenCalledWith(
      record.id,
      watermark,
    );
  });

  it('makes a UI-style background runtime ready before draining its prequeued initial turn', async () => {
    const runtime = createGrokRuntime(
      'app-background',
      { cwd: '/repo', prompt: 'hello', model: 'grok-latest' } as GrokCreateOpts,
      null,
    );
    runtime.queue.push({ id: 'initial-message', text: 'hello' });
    const request = vi.fn(async (method: unknown) => {
      if (method === methods.agent.session.new) {
        return {
          sessionId: 'native-background',
          models: { currentModelId: 'grok-4.5', availableModels: [] },
          modes: { currentModeId: 'default', availableModes: [] },
        };
      }
      if (method === GROK_SESSION_INFO_METHOD) {
        return {
          result: {
            context: { used: 7_500, total: 500_000, usagePct: 2 },
          },
        };
      }
      return {};
    });
    const process = {
      connection: { agent: { request, notify: vi.fn() } },
      initializeResponse: {
        agentCapabilities: { loadSession: true },
        _meta: { modelState: { currentModelId: 'native-default' } },
      },
      onExit: vi.fn(),
      stop: vi.fn(async () => undefined),
      isStopping: false,
      diagnostics: '',
    } as unknown as GrokAcpProcess;
    acpStartMock.mockResolvedValue(process);
    const runtimes = new Map([[runtime.applicationSessionId, runtime]]);
    const drain = vi.fn(async (candidate: GrokRuntime) => {
      expect(candidate.ready).toBe(true);
      expect(candidate.queue).toEqual([
        { id: 'initial-message', text: 'hello' },
      ]);
    });
    const persist = vi.fn();
    const context = {
      sessionManager: { updateCliSessionId: updateCliSessionIdMock },
      runtimeHost,
      binaryPath: null,
      runtimes,
      sessionSetup: {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => false,
        getAgentProfilePrompt: async () => null,
        getPluginDirectories: async () => [],
      },
      permissionController: { handle: vi.fn() },
      emit: vi.fn(),
      emitError: vi.fn(),
      isCurrentRuntime: (candidate: GrokRuntime) => candidate === runtime,
      requireNativeSession: () => 'native-background',
      confirmPromptAccepted: vi.fn(),
      observeModelActivity: vi.fn(),
      drain,
      dispose: vi.fn(async () => undefined),
    } as unknown as GrokRuntimeStartContext;

    await startGrokRuntimeInBackground(runtime, context, persist);

    expect(runtime.nativeSessionId).toBe('native-background');
    expect(runtime).toMatchObject({
      model: 'grok-latest',
      modelOverride: 'grok-latest',
      runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
    });
    await vi.waitFor(() => expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'context-usage',
        payload: {
          usedTokens: 7_500,
          windowTokens: 500_000,
          capacitySource: 'runtime-usage',
          runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
        },
      }),
    ));
    expect(request).toHaveBeenCalledWith(
      GROK_SESSION_INFO_METHOD,
      { sessionId: 'native-background' },
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    );
    const startOptions = acpStartMock.mock.calls[0]![0] as {
      onSessionUpdate: (notification: {
        sessionId: string;
        update: {
          sessionUpdate: 'usage_update';
          used: number;
          size: number;
        };
      }) => void;
    };
    startOptions.onSessionUpdate({
      sessionId: 'native-background',
      update: { sessionUpdate: 'usage_update', used: 12_000, size: 256_000 },
    });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'context-usage',
      payload: {
        usedTokens: 12_000,
        windowTokens: 256_000,
        capacitySource: 'runtime-usage',
        runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
      },
    }));
    expect(drain).toHaveBeenCalledWith(runtime);
    expect(persist).toHaveBeenCalledWith(runtime);
  });

  it('bounds startup setMode and disposes instead of assuming a timeout was not applied', async () => {
    const runtime = recoverGrokRuntime(makeRecord());
    const request = vi.fn((method: unknown) => {
      if (method === methods.agent.session.load) {
        return Promise.resolve({
          modes: { currentModeId: 'default', availableModes: [] },
        });
      }
      return new Promise(() => undefined);
    });
    const process = {
      connection: { agent: { request, notify: vi.fn() } },
      initializeResponse: {
        agentCapabilities: { loadSession: true },
        _meta: { modelState: { currentModelId: 'native-default' } },
      },
      onExit: vi.fn(),
      stop: vi.fn(async () => undefined),
      isStopping: false,
      diagnostics: '',
    } as unknown as GrokAcpProcess;
    acpStartMock.mockResolvedValue(process);
    const runtimes = new Map([[runtime.applicationSessionId, runtime]]);
    const dispose = vi.fn(async (candidate: GrokRuntime) => {
      candidate.closed = true;
      candidate.disposed = true;
      candidate.process = null;
    });
    const context = {
      sessionManager: { updateCliSessionId: updateCliSessionIdMock },
      runtimeHost,
      binaryPath: null,
      runtimes,
      sessionSetup: {
        mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
        isAgentDeckMcpEnabled: () => false,
        getAgentProfilePrompt: async () => null,
        getPluginDirectories: async () => [],
      },
      permissionController: { handle: vi.fn() },
      emit: vi.fn(),
      emitError: vi.fn(),
      isCurrentRuntime: (candidate: GrokRuntime) => candidate === runtime,
      requireNativeSession: () => 'native-grok',
      confirmPromptAccepted: vi.fn(),
      drain: vi.fn(async () => undefined),
      dispose,
      requestTimeoutMs: 5,
    } as unknown as GrokRuntimeStartContext;

    await expect(startGrokRuntime(runtime, context)).rejects.toThrow(
      '结果无法确认',
    );

    expect(runtime.nativeDefaultModel).toBe('native-default');
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.disposed).toBe(true);
  });
});
