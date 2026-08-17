import { describe, expect, it } from 'vitest';

import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
} from './thread-params';

describe('Codex Gateway profile thread config', () => {
  it('layers the complete Gateway below custom-agent and Agent Deck config at every boundary', () => {
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      gatewayConfigOverrides: {
        model: 'gateway-model',
        model_provider: 'internal-provider',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
        mcp_servers: { gateway: { command: 'gateway-mcp' } },
      },
      configOverrides: {
        model_auto_compact_token_limit: 850_000,
      },
    };
    const expected = {
      model: 'gateway-model',
      model_provider: 'internal-provider',
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 850_000,
      mcp_servers: {
        gateway: { command: 'gateway-mcp' },
        'agent-deck': { url: 'http://127.0.0.1:3210/mcp' },
      },
      skip_git_repo_check: true,
    };
    const baseConfig = {
      mcp_servers: { 'agent-deck': { url: 'http://127.0.0.1:3210/mcp' } },
    };

    expect(buildThreadStartParams(options, baseConfig).config).toEqual(expected);
    expect(buildThreadResumeParams('thread-1', options, baseConfig).config).toEqual(expected);
    expect(buildThreadForkParams('source-1', 'turn-1', options, baseConfig).config).toEqual(expected);
  });
});
