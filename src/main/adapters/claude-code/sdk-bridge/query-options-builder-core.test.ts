import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildClaudeQueryOptionsCore,
  type BuildClaudeQueryOptionsCoreArgs,
} from './query-options-builder-core';

function baseArgs(
  overrides: Partial<BuildClaudeQueryOptionsCoreArgs> = {},
): BuildClaudeQueryOptionsCoreArgs {
  return {
    cwd: '/workspace',
    canUseTool: vi.fn(async () => ({ behavior: 'allow' })) as CanUseTool,
    sandboxOpts: {},
    systemPromptAppend: 'agent-deck baseline',
    plugins: [],
    runtime: {
      executable: 'node',
      env: { KEEP: 'value', AGENT_DECK_ORIGIN: 'caller-value' },
    },
    claudeBinary: undefined,
    agentDeckMcpToolPattern: 'mcp__host-owned__*',
    mcpServers: { agentDeckMcpServer: null },
    ...overrides,
  };
}

describe('Claude query options Core', () => {
  it('builds the fixed SDK baseline without enabling optional MCP authority', () => {
    const args = baseArgs();
    const options = buildClaudeQueryOptionsCore(args);

    expect(options).toMatchObject({
      cwd: '/workspace',
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'agent-deck baseline',
      },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      executable: 'node',
      env: { KEEP: 'value', AGENT_DECK_ORIGIN: 'sdk' },
    });
    expect(options.canUseTool).toBe(args.canUseTool);
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('allowedTools');
  });

  it('enables dangerous bypass only for the exact permission mode', () => {
    expect(buildClaudeQueryOptionsCore(baseArgs({
      permissionMode: 'dontAsk',
    })).allowDangerouslySkipPermissions).toBe(false);
    expect(buildClaudeQueryOptionsCore(baseArgs({
      permissionMode: 'bypassPermissions',
    })).allowDangerouslySkipPermissions).toBe(true);
  });

  it('uses the host-supplied MCP namespace and preserves session-local options', () => {
    const server = { name: 'agent-deck' } as unknown as McpSdkServerConfigWithInstance;
    const hooks = { Stop: [] } as NonNullable<BuildClaudeQueryOptionsCoreArgs['hooks']>;
    const options = buildClaudeQueryOptionsCore(baseArgs({
      mcpServers: { agentDeckMcpServer: server },
      settingsPath: '/gateway/deepseek.json',
      claudeBinary: '/app.asar.unpacked/claude',
      model: 'provider/model',
      effort: 'xhigh',
      agentName: 'reviewer-claude',
      agents: {
        'reviewer-claude': {
          description: 'Review code',
          prompt: 'Review carefully.',
        },
      },
      hooks,
      sandboxOpts: {
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
      },
    }));

    expect(options.mcpServers).toEqual({ 'agent-deck': server });
    expect(options.allowedTools).toEqual(['mcp__host-owned__*']);
    expect(options).toMatchObject({
      settings: '/gateway/deepseek.json',
      pathToClaudeCodeExecutable: '/app.asar.unpacked/claude',
      model: 'provider/model',
      effort: 'xhigh',
      agent: 'reviewer-claude',
      hooks,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      },
    });
  });
});
