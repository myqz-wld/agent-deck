import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../../app-server/client';
import * as tokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import {
  appServerClientMock, ControlledThread, gatewayProfileMock, makeBridge, PushThread, sessionRepo,
} from './create-session-fixture';

describe('Codex model catalog startup delivery', () => {
  it.each([false, true])('resolves the Gateway and Agent layer before client construction (resume=%s)', async (resume) => {
    vi.useFakeTimers();
    gatewayProfileMock.resolve.mockReturnValueOnce({
      id: 'custom', profilePath: '/owner/gateways/custom.toml', modelProvider: 'custom',
      configOverrides: { model_catalog_json: '/owner/gateway-models.json' },
    });
    if (resume) {
      vi.mocked(sessionRepo.get).mockReturnValue({
        id: 'app-a', agentId: 'codex-cli', cwd: '/repo', runtimeProvider: 'custom',
        cliSessionId: 'native-a', codexSandbox: 'workspace-write',
      } as ReturnType<typeof sessionRepo.get>);
      const thread = new ControlledThread();
      thread.startedThreadId = 'native-a';
      appServerClientMock.nextThread = thread;
    } else appServerClientMock.nextThread = new PushThread();

    await makeBridge().createSession({
      cwd: '/repo', prompt: 'fixture', ...(resume ? { resume: 'app-a' } : { provider: 'custom' }),
      codexConfigOverrides: { model_catalog_json: '/owner/agent-models.json' },
    });
    expect(gatewayProfileMock.resolve).toHaveBeenCalledWith('custom');
    expect(appServerClientMock.CodexAppServerClient).toHaveBeenCalledWith(expect.objectContaining({
      modelCatalogPath: '/owner/agent-models.json',
    }), expect.anything());
  });

  it('rejects a relative catalog before starting a provider process', async () => {
    await expect(makeBridge().createSession({
      cwd: '/repo', prompt: 'fixture', codexConfigOverrides: { model_catalog_json: 'models.json' },
    })).rejects.toThrow('运行主机上的绝对文件路径');
    expect(appServerClientMock.CodexAppServerClient).not.toHaveBeenCalled();
  });

  it('rejects a cached catalog change without allocating/releasing tokens or disposing the existing client', async () => {
    const bridge = makeBridge();
    const cached = { modelCatalogPath: '/owner/old.json', dispose: vi.fn() } as unknown as CodexAppServerClient;
    const clients = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> }).codexBySession;
    clients.set('app-live', cached);
    const token = tokenMap.allocate('app-live');
    await expect(bridge.createSession({
      cwd: '/repo', resume: 'app-live', prompt: 'fixture',
      codexConfigOverrides: { model_catalog_json: '/owner/new.json' },
    })).rejects.toThrow('请新建会话');
    expect(clients.get('app-live')).toBe(cached);
    expect(cached.dispose).not.toHaveBeenCalled();
    expect(tokenMap.get(token)).not.toBeNull();
  });
});
