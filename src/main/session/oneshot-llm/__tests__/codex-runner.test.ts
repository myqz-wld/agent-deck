import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { CodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';
import { runCodexOneshotWithHost } from '../codex-runner-core';

describe('Codex oneshot provider config', () => {
  it('adds matching Gateway capacity without weakening isolated runtime controls', async () => {
    const startThread = vi.fn((_options: CodexThreadOptions) => ({
      run: async () => ({ finalResponse: 'done' }),
    }));
    const resolveProviderConfigOverrides = vi.fn(() => ({
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 900_000,
    }));

    await expect(runCodexOneshotWithHost({
      cwd: '/repo',
      prompt: 'summarize',
      provider: 'openrouter',
      timeoutMs: 5_000,
      timeoutErrorMessage: 'timeout',
    }, {
      getInstance: async () => ({ startThread }),
      resolveProviderConfigOverrides,
      createIsolatedCwd: () => mkdtempSync(join(tmpdir(), 'codex-oneshot-profile-')),
    })).resolves.toBe('done');

    expect(resolveProviderConfigOverrides).toHaveBeenCalledWith('openrouter');
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      useBaseConfig: false,
      networkAccessEnabled: false,
      configOverrides: expect.objectContaining({
        model_provider: 'openrouter',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
        mcp_servers: {},
      }),
    }));
  });
});
