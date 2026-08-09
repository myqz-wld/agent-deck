import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpServersWithHost,
  type ClaudeMcpServerHost,
} from './mcp-server-core';

function host(enabled: boolean): ClaudeMcpServerHost<{ name: string }> {
  return {
    createServer: vi.fn(async () => ({ name: 'agent-deck' })),
    onServerAttached: vi.fn(),
    readEnabled: vi.fn(() => enabled),
  };
}

describe('Claude MCP server Core', () => {
  it('performs no server or diagnostic work when disabled', async () => {
    const dependencies = host(false);

    await expect(buildMcpServersWithHost(
      dependencies,
      { applicationSid: 'application-a' },
      'claude-code',
    )).resolves.toEqual({ agentDeckMcpServer: null });

    expect(dependencies.createServer).not.toHaveBeenCalled();
    expect(dependencies.onServerAttached).not.toHaveBeenCalled();
  });

  it('retains a lazy provider for the latest application session identity', async () => {
    const dependencies = host(true);
    const internal = { applicationSid: 'temporary-a' };

    await expect(buildMcpServersWithHost(
      dependencies,
      internal,
      'claude-code',
    )).resolves.toEqual({ agentDeckMcpServer: { name: 'agent-deck' } });

    const provider = vi.mocked(dependencies.createServer).mock.calls[0]?.[0];
    expect(provider?.()).toBe('temporary-a');
    internal.applicationSid = 'application-a';
    expect(provider?.()).toBe('application-a');
    expect(dependencies.createServer).toHaveBeenCalledWith(provider, 'claude-code');
    expect(dependencies.onServerAttached).toHaveBeenCalledOnce();
  });
});
