import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { buildClaudeQueryOptions } from '../query-options-builder';

function buildBaseArgs(): Parameters<typeof buildClaudeQueryOptions>[0] {
  return {
    cwd: '/repo',
    canUseTool: (async () => ({ behavior: 'allow' })) as CanUseTool,
    sandboxOpts: {},
    systemPromptAppend: '',
    plugins: [],
    runtime: {
      executable: 'node',
      env: {},
    },
    claudeBinary: undefined,
    mcpServers: {
      agentDeckMcpServer: null,
    },
  };
}

describe('buildClaudeQueryOptions', () => {
  it('passes xhigh effort to the Claude SDK options', () => {
    const options = buildClaudeQueryOptions({
      ...buildBaseArgs(),
      effort: 'xhigh',
    });

    expect(options.effort).toBe('xhigh');
  });

  it('omits effort when no per-session thinking override is set', () => {
    const options = buildClaudeQueryOptions(buildBaseArgs());

    expect(options).not.toHaveProperty('effort');
  });
});
