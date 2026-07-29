import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSdkBridge } from '../sdk-bridge';
import {
  codexUsageUnavailableSnapshot,
  isExpectedCodexUsageUnavailable,
  readCodexUsageSnapshotInBackground,
} from '../usage-snapshot';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));

vi.mock('../usage-snapshot', () => ({
  codexUsageUnavailableSnapshot: vi.fn(() => ({
    provider: 'codex-cli',
    label: 'Codex CLI',
    status: 'unavailable',
    message: 'Codex 额度信息暂不可读，请确认 Codex 已登录且网络可用',
    windows: [],
    updatedAt: 456,
  })),
  isExpectedCodexUsageUnavailable: vi.fn((err: unknown) =>
    /authentication required|failed to fetch codex rate limits|backend-api\/wham\/usage/i.test(
      err instanceof Error ? err.message : String(err),
    ),
  ),
  readCodexUsageSnapshotInBackground: vi.fn().mockResolvedValue({
    provider: 'codex-cli',
    label: 'Codex CLI',
    status: 'ok',
    windows: [],
    updatedAt: 123,
  }),
}));

function makeBridge(): CodexSdkBridge {
  return new CodexSdkBridge({ emit: vi.fn() });
}

function setCodexClients(bridge: CodexSdkBridge, clients: unknown[]): void {
  (bridge as unknown as { codexBySession: Map<string, unknown> }).codexBySession = new Map(
    clients.map((client, index) => [`sid-${index}`, client]),
  );
}

describe('CodexSdkBridge getUsageSnapshot', () => {
  beforeEach(() => {
    vi.mocked(readCodexUsageSnapshotInBackground).mockClear();
    vi.mocked(isExpectedCodexUsageUnavailable).mockClear();
    vi.mocked(codexUsageUnavailableSnapshot).mockClear();
    for (const method of Object.values(mocks.logger)) method.mockReset();
  });

  it('uses the background usage probe when no client exists', async () => {
    const snapshot = await makeBridge().getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      label: 'Codex CLI',
      status: 'ok',
    });
    expect(readCodexUsageSnapshotInBackground).toHaveBeenCalledTimes(1);
  });

  it('skips cached clients whose app-server process is not alive and uses the probe', async () => {
    const bridge = makeBridge();
    const request = vi.fn();
    setCodexClients(bridge, [{ isProcessAlive: false, request }]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(request).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('ok');
    expect(readCodexUsageSnapshotInBackground).toHaveBeenCalledTimes(1);
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
      label: 'Codex CLI',
      status: 'ok',
    });
    expect(snapshot.windows[0]?.usedPercent).toBe(12);
    expect(readCodexUsageSnapshotInBackground).not.toHaveBeenCalled();
  });

  it('maps expected live-client quota auth failures to unavailable', async () => {
    const bridge = makeBridge();
    const request = vi
      .fn()
      .mockRejectedValue(new Error('chatgpt authentication required to read rate limits (code -32600)'));
    setCodexClients(bridge, [{ isProcessAlive: true, request }]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(request).toHaveBeenCalledWith('account/rateLimits/read', undefined);
    expect(isExpectedCodexUsageUnavailable).toHaveBeenCalledTimes(1);
    expect(codexUsageUnavailableSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      label: 'Codex CLI',
      status: 'unavailable',
    });
    expect(readCodexUsageSnapshotInBackground).not.toHaveBeenCalled();
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('returns a generic error snapshot without live-client raw logging', async () => {
    const bridge = makeBridge();
    const request = vi.fn().mockRejectedValue(
      new Error('Bearer private-token /Users/private/repo raw provider response'),
    );
    setCodexClients(bridge, [{ isProcessAlive: true, request }]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'codex-cli',
      label: 'Codex CLI',
      status: 'error',
      message: '额度信息读取失败，请稍后重试',
    });
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(JSON.stringify(snapshot)).not.toContain('/Users/private/repo');
  });
});
