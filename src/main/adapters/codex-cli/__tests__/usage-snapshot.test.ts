import { describe, expect, it, vi } from 'vitest';
import { CodexSdkBridge } from '../sdk-bridge';

function makeBridge(): CodexSdkBridge {
  return new CodexSdkBridge({ emit: vi.fn() });
}

function setCodexClients(bridge: CodexSdkBridge, clients: unknown[]): void {
  (bridge as unknown as { codexBySession: Map<string, unknown> }).codexBySession = new Map(
    clients.map((client, index) => [`sid-${index}`, client]),
  );
}

describe('CodexSdkBridge getUsageSnapshot', () => {
  it('does not start a Codex app-server when no client exists', async () => {
    const snapshot = await makeBridge().getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'unavailable',
      message: '需要已有 Codex 会话才能读取额度窗口',
    });
  });

  it('skips cached clients whose app-server process is not alive', async () => {
    const bridge = makeBridge();
    const request = vi.fn();
    setCodexClients(bridge, [{ isProcessAlive: false, request }]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(request).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('unavailable');
  });

  it('reads rate limits through an already alive app-server client', async () => {
    const bridge = makeBridge();
    const request = vi.fn().mockResolvedValue({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    });
    setCodexClients(bridge, [{ isProcessAlive: true, request }]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      status: 'ok',
    });
    expect(snapshot.windows[0]?.usedPercent).toBe(12);
  });
});
