import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServerCoreCodexClient } from './provider-codex-host';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

describe('Server Core Codex model catalog startup', () => {
  it('uses only owning-host catalog argv and retains the trusted permission/MCP arguments', async () => {
    const stopped = new Error('fixture stops before process creation');
    vi.mocked(spawn).mockImplementation(() => { throw stopped; });
    const client = createServerCoreCodexClient({
      env: { CODEX_HOME: '/owner/private/.codex' },
      modelCatalogPath: '/owner/private/models.json',
      config: { mcp_servers: { 'agent-deck': { url: 'http://127.0.0.1:8000/mcp' } } },
    }, {
      settings: {},
      workspaceBoundary: {
        workspaceRoot: '/owner/workspace', privateRoot: '/owner/private',
        providerHomeRoot: '/owner/private/home', providerCacheRoot: '/owner/private/cache',
        providerTempRoot: '/owner/private/tmp', runtimeReadRoots: ['/owner/providers'],
      },
    } as unknown as Parameters<typeof createServerCoreCodexClient>[1]);
    try {
      await expect(client.request('initialize', {})).rejects.toThrow(stopped);
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args.slice(0, 2)).toEqual(['-c', 'model_catalog_json="/owner/private/models.json"']);
      expect(args.slice(-2)).toEqual(['app-server', '--stdio']);
      expect(args).toContain('default_permissions="agent-deck-workspace-read-only"');
      expect(args).toContain('features.hooks=false');
      expect(args).toContain('features.plugins=false');
      expect(args.find((arg) => arg.startsWith('mcp_servers='))).toContain('agent-deck');
      expect(vi.mocked(spawn).mock.calls[0][2]?.env?.CODEX_HOME).toBe('/owner/private/.codex');
    } finally { client.dispose(); }
  });
});
