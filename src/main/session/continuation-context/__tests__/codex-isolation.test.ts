import { describe, expect, it } from 'vitest';
import { __testables } from '@main/adapters/codex-cli/app-server/client';
import type { JsonObject } from '@main/adapters/codex-cli/app-server/protocol';
import { CONTINUATION_CHECKPOINT_JSON_SCHEMA } from '../checkpoint-schema';
import { buildCodexCompactorThreadOptions, codexCompactorIsolationAttestation } from '../codex-isolation';
import { createCheckpointGeneratorRuntime } from '../runtime';

const generator = {
  adapter: 'codex-cli' as const,
  model: 'gpt-test',
  thinking: 'low' as const,
  contextWindowTokens: 128_000,
  configFingerprint: 'codex-test',
};

describe('Codex checkpoint compactor isolation', () => {
  it('builds actual thread/turn params with every available no-side-effect control', () => {
    const options = buildCodexCompactorThreadOptions({ generator, emptyWorkingDirectory: '/tmp/empty' });
    const thread = __testables.buildThreadStartParams(options, {
      mcp_servers: { inherited: { command: 'danger' } },
      features: { shell_tool: true, multi_agent: true },
    });
    const turn = __testables.buildTurnStartParams(
      'thread',
      [{ type: 'text', text: 'fold', text_elements: [] }],
      options,
      null,
      {
        outputSchema: CONTINUATION_CHECKPOINT_JSON_SCHEMA as JsonObject,
        environments: [],
        runtimeWorkspaceRoots: [],
      },
    );
    expect(thread).toMatchObject({
      cwd: '/tmp/empty', sandbox: 'read-only', approvalPolicy: 'never', dynamicTools: [],
      environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], ephemeral: true,
    });
    expect(thread.config).not.toHaveProperty('mcp_servers.inherited');
    expect(thread.config).toMatchObject({
      mcp_servers: {},
      features: { shell_tool: false, unified_exec: false, multi_agent: false, browser_use: false },
    });
    expect(turn).toMatchObject({
      environments: [], runtimeWorkspaceRoots: [], outputSchema: CONTINUATION_CHECKPOINT_JSON_SCHEMA,
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('fails closed before a Codex turn because 0.144 cannot attest the final model-visible registry', async () => {
    expect(codexCompactorIsolationAttestation()).toMatchObject({ proven: false });
    const runtime = createCheckpointGeneratorRuntime(generator);
    expect(runtime.isolation).toBe('fail-closed');
    await expect(runtime.generate({ prompt: 'x', timeoutMs: 1, maxOutputBytes: 100, remainingCalls: 1 }))
      .rejects.toMatchObject({ code: 'codex-generator-tools-unproven', providerCalls: 0 });
  });
});
