import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(async () => ({ name: 'agent-deck' })),
  getSetting: vi.fn(() => true),
  info: vi.fn(),
}));

vi.mock('@main/agent-deck-mcp/server', () => ({
  getAgentDeckMcpServerForSession: mocks.createServer,
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: mocks.info }) },
}));

describe('desktop Claude MCP server host', () => {
  it('owns the feature setting, server factory, and attachment diagnostic', async () => {
    const { desktopClaudeMcpServerHost: host } = await import('./mcp-server-host');
    const provider = () => 'application-a';

    expect(host.readEnabled()).toBe(true);
    await expect(host.createServer(provider, 'claude-code'))
      .resolves.toEqual({ name: 'agent-deck' });
    host.onServerAttached();

    expect(mocks.getSetting).toHaveBeenCalledWith('enableAgentDeckMcp');
    expect(mocks.createServer).toHaveBeenCalledWith(provider, 'claude-code');
    expect(mocks.info).toHaveBeenCalledOnce();
  });
});
