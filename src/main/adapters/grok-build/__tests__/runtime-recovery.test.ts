import { beforeEach, describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';

import type { GrokCreateOpts } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import type { GrokAcpProcess } from '../acp-process';
import type { GrokRuntimeStartContext } from '../runtime-start';

const acpStartMock = vi.hoisted(() => vi.fn());
const resolveGrokBinaryMock = vi.hoisted(() => vi.fn(async () => '/fake/grok'));
const sessionRepoMock = vi.hoisted(() => ({
  setAgentRuntimeProfile: vi.fn(),
  setModel: vi.fn(),
  setThinking: vi.fn(),
  setSessionMode: vi.fn(),
  setGrokSandbox: vi.fn(),
  setGrokUsageWatermark: vi.fn(),
  get: vi.fn(),
}));

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
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: sessionRepoMock,
}));
vi.mock('@main/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: { updateCliSessionId: vi.fn() },
}));

import {
  createGrokRuntime,
  persistGrokRuntimeMetadata,
  persistGrokUsageWatermark,
  recoverGrokRuntime,
} from '../runtime-factory';
import { startGrokRuntime } from '../runtime-start';

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
    const runtimes = new Map([[runtime.applicationSessionId, runtime]]);
    const context = {
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
  });

  it('restores profile fields for explicit resume and persists them atomically', () => {
    const record = makeRecord();
    const runtime = createGrokRuntime(
      record.id,
      { cwd: record.cwd, resume: record.id } as GrokCreateOpts,
      record,
    );
    sessionRepoMock.get.mockReturnValue(record);

    persistGrokRuntimeMetadata(runtime);

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
      standardUsageBaselineReady: true,
    });

    persistGrokUsageWatermark(runtime);
    expect(sessionRepoMock.setGrokUsageWatermark).toHaveBeenCalledWith(
      record.id,
      watermark,
    );
  });

  it('treats the first standard usage snapshot as baseline for legacy recovered rows', () => {
    const runtime = recoverGrokRuntime(makeRecord());
    expect(runtime.translation).toMatchObject({
      lastUsage: null,
      standardUsageBaselineReady: false,
    });
  });
});
