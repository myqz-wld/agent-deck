import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { CodexThreadOptions } from '@main/adapters/codex-cli/sdk-bridge/thread-options-builder';
import { runCodexOneshotWithHost } from '../codex-runner-core';

describe('Codex oneshot provider config', () => {
  it('adds the selected full Gateway config without weakening isolated runtime controls', async () => {
    const startThread = vi.fn((_options: CodexThreadOptions) => ({
      run: async () => ({ finalResponse: 'done' }),
    }));
    const resolveGatewayProfile = vi.fn(() => ({
      id: 'openrouter',
      profilePath: '/codex/gateways/openrouter.toml',
      modelProvider: 'internal-provider',
      defaultModel: 'gateway-model',
      defaultThinking: 'xhigh' as const,
      configOverrides: {
        model: 'gateway-model',
        model_provider: 'internal-provider',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      },
    }));

    await expect(runCodexOneshotWithHost({
      cwd: '/repo',
      prompt: 'summarize',
      provider: 'openrouter',
      timeoutMs: 5_000,
      timeoutErrorMessage: 'timeout',
    }, {
      getInstance: async () => ({ startThread }),
      resolveGatewayProfile,
      createIsolatedCwd: () => mkdtempSync(join(tmpdir(), 'codex-oneshot-profile-')),
    })).resolves.toBe('done');

    expect(resolveGatewayProfile).toHaveBeenCalledWith('openrouter');
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      useBaseConfig: false,
      networkAccessEnabled: false,
      model: 'gateway-model',
      modelProvider: 'internal-provider',
      modelReasoningEffort: 'xhigh',
      gatewayConfigOverrides: expect.objectContaining({
        model_provider: 'internal-provider',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      }),
      configOverrides: expect.objectContaining({
        mcp_servers: {},
      }),
    }));
  });
});
