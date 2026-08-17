import { describe, expect, it } from 'vitest';

import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
} from './thread-params';

describe('Codex Gateway profile thread config', () => {
  it('layers provider capacity below custom-agent overrides at every thread boundary', () => {
    const options = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      providerConfigOverrides: {
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      },
      configOverrides: {
        model_auto_compact_token_limit: 850_000,
      },
    };
    const expected = {
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 850_000,
      skip_git_repo_check: true,
    };

    expect(buildThreadStartParams(options, null).config).toEqual(expected);
    expect(buildThreadResumeParams('thread-1', options, null).config).toEqual(expected);
    expect(buildThreadForkParams('source-1', 'turn-1', options, null).config).toEqual(expected);
  });
});
