import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  diagnostics: { scope: vi.fn() },
  emit: vi.fn(),
  guard: vi.fn(() => true),
  liveRate: { emitTokenRateTick: vi.fn() },
  pendingTransition: vi.fn(() => true),
  records: {
    get: vi.fn(() => ({ id: 'session-a' })),
    setAgentRuntimeProfile: vi.fn(),
    setRuntimeProvider: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setSessionMode: vi.fn(),
    setGrokSandbox: vi.fn(),
    setGrokUsageWatermark: vi.fn(),
  },
  transaction: vi.fn((operation: () => unknown) => operation),
  prepareBrowser: vi.fn(() => ({ environment: { PATH: '/browser-bin:/usr/bin' } })),
  revokeBrowser: vi.fn(),
}));

vi.mock('@main/event-bus', () => ({ eventBus: { emit: mocks.emit } }));
vi.mock('@main/session/hand-off/ingress-guard', () => ({
  guardHandOffSourceIngress: mocks.guard,
}));
vi.mock('@main/session/worktree-transition/tool-invocation-registry', () => ({
  worktreeToolInvocationRegistry: {
    hasPendingTransition: mocks.pendingTransition,
  },
}));
vi.mock('@main/store/db', () => ({
  getDb: () => ({ transaction: mocks.transaction }),
}));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: mocks.records }));
vi.mock('./bridge-diagnostics-host', () => ({
  desktopGrokBridgeDiagnostics: mocks.diagnostics,
}));
vi.mock('./live-token-rate-host', () => ({
  desktopGrokLiveRateObserver: mocks.liveRate,
}));
vi.mock('@main/browser-use/browser-runtime-context-host', () => ({
  prepareBrowserRuntimeEnvironment: mocks.prepareBrowser,
  revokeBrowserRuntimeSession: mocks.revokeBrowser,
}));

import { desktopGrokBridgeRuntimeHost as host } from './bridge-runtime-host';

describe('desktop Grok bridge runtime host', () => {
  it('owns persistence, publication, ingress, diagnostics, and live-rate effects', () => {
    expect(host.diagnostics).toBe(mocks.diagnostics);
    expect(host.liveRate).toBe(mocks.liveRate);
    expect(host.transaction(() => 'committed')).toBe('committed');
    expect(mocks.transaction).toHaveBeenCalledOnce();

    host.records.setModel('session-a', 'grok-4.5');
    expect(mocks.records.setModel).toHaveBeenCalledWith(
      'session-a',
      'grok-4.5',
    );
    host.publishSessionUpdated('session-a');
    expect(mocks.emit).toHaveBeenCalledWith(
      'session-upserted',
      expect.objectContaining({ id: 'session-a' }),
    );

    const ingress = {
      sourceSessionId: 'session-a',
      text: 'continue',
      emit: vi.fn(),
      replay: vi.fn(async () => undefined),
    };
    expect(host.guardHandOffSourceIngress(ingress)).toBe(true);
    expect(mocks.guard).toHaveBeenCalledWith({
      ...ingress,
      agentId: 'grok-build',
    });
    expect(host.hasPendingWorktreeTransition('session-a')).toBe(true);
    expect(host.prepareBrowserRuntimeEnvironment?.('session-a')).toEqual({
      PATH: '/browser-bin:/usr/bin',
    });
    expect(mocks.prepareBrowser).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: 'session-a',
      adapterId: 'grok-build',
    }));
    host.revokeBrowserRuntime?.('session-a');
    expect(mocks.revokeBrowser).toHaveBeenCalledWith('session-a');
  });
});
