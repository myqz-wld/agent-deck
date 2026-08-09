import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { CodexAppServerClient } from '../app-server/client';
import {
  ensureCodexClientWithHost,
  type CodexClientConstructionHost,
} from './client-construction';

function host(createClient: CodexClientConstructionHost['createClient']) {
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
      nodeReplBrowserBootstrap: true,
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
});
