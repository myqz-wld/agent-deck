import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => undefined),
  claimAsSdk: vi.fn(),
  releaseSdkClaim: vi.fn(),
  markClosed: vi.fn(),
  startRuntime: vi.fn(async () => false),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    delete: mocks.deleteSession,
    claimAsSdk: mocks.claimAsSdk,
    releaseSdkClaim: mocks.releaseSdkClaim,
    markClosed: mocks.markClosed,
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => null),
    setAgentRuntimeProfile: vi.fn(),
    setRuntimeProvider: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setSessionMode: vi.fn(),
    setGrokSandbox: vi.fn(),
  },
}));
vi.mock('@main/store/db', () => ({
  getDb: () => ({ transaction: (work: () => void) => work }),
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/agent-deck-mcp/mcp-session-token-map', () => ({
  allocate: vi.fn(() => 'token'),
  release: vi.fn(),
}));
vi.mock('../runtime-start', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-start')>();
  return {
    ...actual,
    startGrokRuntime: mocks.startRuntime,
    startGrokRuntimeInBackground: vi.fn(async () => undefined),
  };
});

import { GrokBuildBridge } from '../bridge';

const turn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startRuntime.mockResolvedValue(false);
  mocks.deleteSession.mockResolvedValue(undefined);
  mocks.markClosed.mockReset();
});

describe('Grok strict startup cleanup', () => {
  it('deletes a newly registered row when trusted startup never yields a native session', async () => {
    const registered: string[] = [];
    const bridge = new GrokBuildBridge({
      emit: vi.fn(),
      permissionTimeoutMs: 1_000,
      mcpHttpUrl: 'http://127.0.0.1:1/mcp',
      isAgentDeckMcpEnabled: () => false,
      getAgentProfilePrompt: async () => null,
      getPluginDirectories: async () => [],
    });

    await expect(bridge.createTrustedContinuationSession({
      cwd: '/repo',
      awaitCanonicalId: true,
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'source', depth: 1 },
        hiddenFromHistory: true,
        onRegistered: (sessionId) => registered.push(sessionId),
      },
    }, turn, new TrustedContinuationAcceptanceController())).rejects.toThrow(
      /closed before startup completed/,
    );

    expect(registered).toHaveLength(1);
    expect(mocks.deleteSession).toHaveBeenCalledOnce();
    expect(mocks.deleteSession).toHaveBeenCalledWith(registered[0]);
    expect(mocks.releaseSdkClaim).toHaveBeenCalledWith(registered[0]);
  });

  it('marks the failed registration closed when row deletion itself is rejected', async () => {
    const registered: string[] = [];
    mocks.deleteSession.mockRejectedValueOnce(new Error('delete guarded'));
    const bridge = new GrokBuildBridge({
      emit: vi.fn(),
      permissionTimeoutMs: 1_000,
      mcpHttpUrl: 'http://127.0.0.1:1/mcp',
      isAgentDeckMcpEnabled: () => false,
      getAgentProfilePrompt: async () => null,
      getPluginDirectories: async () => [],
    });

    await expect(bridge.createTrustedContinuationSession({
      cwd: '/repo',
      awaitCanonicalId: true,
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'source', depth: 1 },
        onRegistered: (sessionId) => registered.push(sessionId),
      },
    }, turn, new TrustedContinuationAcceptanceController())).rejects.toThrow();

    expect(mocks.markClosed).toHaveBeenCalledWith(registered[0]);
  });
});
