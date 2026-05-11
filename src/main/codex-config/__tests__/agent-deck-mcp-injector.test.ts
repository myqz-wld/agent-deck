/**
 * Codex agent-deck MCP injector 单测（B'4 / R1.A5 / R1.D7）。
 *
 * buildAgentDeckMcpConfigForCodex 是纯函数，不依赖 Electron / SQLite，直接跑。
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
  AGENT_DECK_MCP_TOKEN_ENV,
  AGENT_DECK_MCP_SERVER_NAME,
} from '../agent-deck-mcp-injector';

const fakeRunningHookServer = {
  isRunning: true,
  listeningPort: 47821,
  mcpBearerToken: 'test-token-12345678',
};
const fakeStoppedHookServer = { ...fakeRunningHookServer, isRunning: false };
const fakeNoTokenHookServer = { ...fakeRunningHookServer, mcpBearerToken: '' };

describe('buildAgentDeckMcpConfigForCodex', () => {
  it('returns null when enableAgentDeckMcp=false', () => {
    expect(
      buildAgentDeckMcpConfigForCodex(
        { enableAgentDeckMcp: false, mcpHttpEnabled: true },
        fakeRunningHookServer,
      ),
    ).toBeNull();
  });

  it('returns null when mcpHttpEnabled=false', () => {
    expect(
      buildAgentDeckMcpConfigForCodex(
        { enableAgentDeckMcp: true, mcpHttpEnabled: false },
        fakeRunningHookServer,
      ),
    ).toBeNull();
  });

  it('returns null when hookServer not running', () => {
    expect(
      buildAgentDeckMcpConfigForCodex(
        { enableAgentDeckMcp: true, mcpHttpEnabled: true },
        fakeStoppedHookServer,
      ),
    ).toBeNull();
  });

  it('returns null when hookServer null', () => {
    expect(
      buildAgentDeckMcpConfigForCodex(
        { enableAgentDeckMcp: true, mcpHttpEnabled: true },
        null,
      ),
    ).toBeNull();
  });

  it('returns null when mcpBearerToken empty', () => {
    expect(
      buildAgentDeckMcpConfigForCodex(
        { enableAgentDeckMcp: true, mcpHttpEnabled: true },
        fakeNoTokenHookServer,
      ),
    ).toBeNull();
  });

  it('returns mcp_servers.agent-deck config when all conditions met', () => {
    const cfg = buildAgentDeckMcpConfigForCodex(
      { enableAgentDeckMcp: true, mcpHttpEnabled: true },
      fakeRunningHookServer,
    );
    expect(cfg).not.toBeNull();
    expect(cfg).toEqual({
      mcp_servers: {
        [AGENT_DECK_MCP_SERVER_NAME]: {
          url: 'http://127.0.0.1:47821/mcp',
          bearer_token_env_var: AGENT_DECK_MCP_TOKEN_ENV,
        },
      },
    });
  });
});

describe('mergeCodexConfig', () => {
  it('returns null when both null', () => {
    expect(mergeCodexConfig(null, null)).toBeNull();
  });

  it('returns existing when override null', () => {
    const existing = { foo: 'bar' };
    expect(mergeCodexConfig(existing, null)).toBe(existing);
  });

  it('returns override when existing null', () => {
    const override = { foo: 'baz' };
    expect(mergeCodexConfig(null, override)).toBe(override);
  });

  it('merges shallow keys', () => {
    const merged = mergeCodexConfig(
      { model: 'gpt-5', other: 'a' },
      { sandbox: 'read-only' },
    );
    expect(merged).toEqual({ model: 'gpt-5', other: 'a', sandbox: 'read-only' });
  });

  it('merges nested mcp_servers (one level)', () => {
    const existing = {
      mcp_servers: {
        userServer: { command: 'node' },
      },
    };
    const override = {
      mcp_servers: {
        'agent-deck': { url: 'http://...', bearer_token_env_var: 'X' },
      },
    };
    const merged = mergeCodexConfig(existing, override);
    expect(merged).toEqual({
      mcp_servers: {
        userServer: { command: 'node' },
        'agent-deck': { url: 'http://...', bearer_token_env_var: 'X' },
      },
    });
  });

  it('override wins on key collision (top-level scalar)', () => {
    const merged = mergeCodexConfig({ model: 'old' }, { model: 'new' });
    expect(merged).toEqual({ model: 'new' });
  });
});
