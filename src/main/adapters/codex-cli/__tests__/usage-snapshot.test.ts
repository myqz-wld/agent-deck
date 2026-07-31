import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSdkBridge } from '../sdk-bridge';
import { ensureCodexClient } from '../sdk-bridge/client-registry';
import type { CodexAppServerOptions } from '../app-server/protocol';
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
  settingsGet: vi.fn(),
  settingsGetAll: vi.fn(),
  skillExtraRoots: vi.fn(),
  appServerClient: vi.fn((options: CodexAppServerOptions) => ({
    options,
    profile: options.profile?.trim() || null,
    isProcessAlive: false,
    request: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: mocks.settingsGet,
    getAll: mocks.settingsGetAll,
  },
}));

vi.mock('@main/codex-config/skills-installer', () => ({
  getCodexSkillExtraRootsForSession: mocks.skillExtraRoots,
}));

vi.mock('../app-server/client', () => ({
  CodexAppServerClient: mocks.appServerClient,
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

describe('ensureCodexClient', () => {
  beforeEach(() => {
    mocks.settingsGet.mockReset();
    mocks.settingsGetAll.mockReset();
    mocks.skillExtraRoots.mockReset();
    mocks.appServerClient.mockClear();
    for (const method of Object.values(mocks.logger)) method.mockReset();
  });

  it('creates and caches a configured per-session client without logging its identity', () => {
    const sessionId = 'raw-private-session-id';
    const sessionToken = 'raw-private-session-token';
    const settings = {
      enableAgentDeckMcp: true,
      mcpHttpEnabled: true,
      permissionTimeoutMs: 1_234,
    };
    const hookServer = {
      isRunning: true,
      listeningPort: 49_321,
      mcpBearerToken: 'raw-private-server-token',
    };
    const clients = new Map();

    mocks.settingsGet.mockReturnValue('  /opt/codex-test  ');
    mocks.settingsGetAll.mockReturnValue(settings);
    mocks.skillExtraRoots.mockReturnValue(['/app-owned/codex-skills']);

    const first = ensureCodexClient({
      clients,
      sessionId,
      sessionToken,
      profile: 'openrouter',
      hookServer: hookServer as never,
    });
    const cached = ensureCodexClient({
      clients,
      sessionId,
      sessionToken: 'must-not-reconfigure-the-cached-client',
      profile: 'openrouter',
      hookServer: null as never,
    });

    expect(cached).toBe(first);
    expect(clients).toEqual(new Map([[sessionId, first]]));
    expect(mocks.appServerClient).toHaveBeenCalledTimes(1);
    expect(mocks.settingsGetAll).toHaveBeenCalledTimes(1);
    expect(mocks.skillExtraRoots).toHaveBeenCalledTimes(1);

    const options = mocks.appServerClient.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      codexPathOverride: '/opt/codex-test',
      profile: 'openrouter',
      config: {
        mcp_servers: {
          'agent-deck': {
            url: 'http://127.0.0.1:49321/mcp',
            bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN',
            tool_timeout_sec: 2,
            required: true,
          },
        },
      },
      env: {
        AGENT_DECK_MCP_TOKEN: sessionToken,
        AGENT_DECK_ORIGIN: 'sdk',
      },
      skillExtraRoots: ['/app-owned/codex-skills'],
    });
    for (const method of Object.values(mocks.logger)) expect(method).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.values(mocks.logger).flatMap((method) => method.mock.calls)))
      .not.toContain(sessionId);
  });

  it('rejects reusing one session client under a different process profile', () => {
    const clients = new Map();
    mocks.settingsGet.mockReturnValue(null);
    mocks.settingsGetAll.mockReturnValue({});
    mocks.skillExtraRoots.mockReturnValue([]);

    ensureCodexClient({
      clients,
      sessionId: 'session',
      sessionToken: 'token',
      profile: 'first',
      hookServer: null as never,
    });

    expect(() => ensureCodexClient({
      clients,
      sessionId: 'session',
      sessionToken: 'token',
      profile: 'second',
      hookServer: null as never,
    })).toThrow(/profile mismatch/);
  });
});

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
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
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
