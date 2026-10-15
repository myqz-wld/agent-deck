import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { CodexAppServerClient } from '../app-server/client';
import {
  ensureCodexClientWithHost,
  type CodexClientConstructionHost,
} from './client-construction';

function host(
  createClient: CodexClientConstructionHost['createClient'],
): CodexClientConstructionHost {
  return {
    createClient,
    readCodexCliPath: vi.fn(() => '  /opt/codex  '),
    readSettings: vi.fn(() => ({
      enableAgentDeckMcp: false,
    } as AppSettings)),
    readSkillExtraRoots: vi.fn(() => ['/skills']),
    snapshotProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  } satisfies CodexClientConstructionHost;
}

describe('Codex client construction Core', () => {
  it('freezes each new client catalog and refuses to replace a cached runtime for a different one', () => {
    const first = { modelCatalogPath: '/owner/models/a.json' } as CodexAppServerClient;
    const createClient = vi.fn(() => first);
    const dependencies = host(createClient);
    const options = { clients: new Map<string, CodexAppServerClient>(), sessionId: 'a',
      sessionToken: 'token-a', hookServer: undefined, modelCatalogPath: first.modelCatalogPath };
    ensureCodexClientWithHost(options, dependencies);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ modelCatalogPath: first.modelCatalogPath }));
    expect(ensureCodexClientWithHost(options, dependencies)).toBe(first);
    expect(() => ensureCodexClientWithHost({ ...options, modelCatalogPath: '/owner/models/b.json' }, dependencies))
      .toThrow('请新建会话');
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(options.clients.get('a')).toBe(first);
  });

  it('returns a cached client without reading host state', () => {
    const cached = {} as CodexAppServerClient;
    const clients = new Map([['session-a', cached]]);
    const createClient = vi.fn();
    const dependencies = host(createClient);

    expect(ensureCodexClientWithHost({
      clients,
      sessionId: 'session-a',
      sessionToken: 'token-a',
      hookServer: undefined,
    }, dependencies)).toBe(cached);
    expect(createClient).not.toHaveBeenCalled();
    expect(dependencies.readSettings).not.toHaveBeenCalled();
  });

  it('freezes per-session identity and registers only the constructed client', () => {
    const client = {} as CodexAppServerClient;
    const createClient = vi.fn(() => client);
    const dependencies = host(createClient);
    const clients = new Map<string, CodexAppServerClient>();

    expect(ensureCodexClientWithHost({
      clients,
      sessionId: 'session-a',
      sessionToken: 'token-a',
      hookServer: undefined,
    }, dependencies)).toBe(client);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      codexPathOverride: '/opt/codex',
      env: {
        AGENT_DECK_MCP_TOKEN: 'token-a',
        AGENT_DECK_ORIGIN: 'sdk',
        PATH: '/usr/bin',
      },
      skillExtraRoots: ['/skills'],
    }));
    expect(clients.get('session-a')).toBe(client);
  });

  it('leaves the client map untouched when construction fails', () => {
    const failure = new Error('construction failed');
    const clients = new Map<string, CodexAppServerClient>();

    expect(() => ensureCodexClientWithHost({
      clients,
      sessionId: 'session-a',
      sessionToken: 'token-a',
      hookServer: undefined,
    }, host(() => { throw failure; }))).toThrow(failure);
    expect(clients.size).toBe(0);
  });

  it('injects the session shim environment and exact Browser socket config together', () => {
    const client = {} as CodexAppServerClient;
    const createClient = vi.fn(() => client);
    const dependencies = host(createClient);
    dependencies.prepareBrowserRuntime = vi.fn((_sessionId, environment) => ({
      environment: {
        ...environment,
        PATH: '/private/browser-bin:/usr/bin',
        AGENT_DECK_BROWSER_RUNTIME_KEY: 'runtime-key',
      },
    }));
    dependencies.browserSocketConfig = vi.fn((environment) => ({
      features: { network_proxy: { unix_sockets: { '/tmp/browser': 'allow' } } },
      shell_environment_policy: { set: { PATH: environment.PATH ?? '' } },
    }));

    ensureCodexClientWithHost({
      clients: new Map(),
      sessionId: 'session-a',
      sessionToken: 'token-a',
      hookServer: undefined,
    }, dependencies);

    expect(dependencies.prepareBrowserRuntime).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ PATH: '/usr/bin' }),
    );
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        PATH: '/private/browser-bin:/usr/bin',
        AGENT_DECK_BROWSER_RUNTIME_KEY: 'runtime-key',
      }),
      config: expect.objectContaining({
        features: { network_proxy: { unix_sockets: { '/tmp/browser': 'allow' } } },
      }),
    }));
  });
});
