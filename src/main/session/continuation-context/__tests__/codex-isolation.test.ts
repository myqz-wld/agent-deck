import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __testables } from '@main/adapters/codex-cli/app-server/client';
import type { JsonObject } from '@main/adapters/codex-cli/app-server/protocol';
import { CONTINUATION_CHECKPOINT_JSON_SCHEMA } from '../checkpoint-schema';
import { buildCodexCompactorThreadOptions, codexCompactorIsolationAttestation } from '../codex-isolation';
import { createCheckpointGeneratorRuntime } from '../runtime';

const harness = vi.hoisted(() => ({
  startThread: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  getCodexInstance: vi.fn(async () => ({ startThread: harness.startThread })),
}));

const generator = {
  adapter: 'codex-cli' as const,
  model: 'gpt-test',
  thinking: 'low' as const,
  contextWindowTokens: 128_000,
  configFingerprint: 'codex-test',
};

const emptyCheckpoint = {
  formatVersion: 1,
  goals: [], userIntent: [], constraints: [], decisions: [], completedWork: [], currentState: [],
  nextSteps: [], openQuestions: [], risks: [], keyFiles: [], commands: [], unresolvedErrors: [],
};

describe('Codex checkpoint compactor isolation', () => {
  beforeEach(() => {
    harness.run.mockReset().mockResolvedValue({
      finalResponse: JSON.stringify(emptyCheckpoint),
    });
    harness.startThread.mockReset().mockReturnValue({ run: harness.run });
  });

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

  it('runs with every hardened option while reporting the remaining unattested boundary', async () => {
    expect(codexCompactorIsolationAttestation()).toMatchObject({ proven: false });
    const runtime = createCheckpointGeneratorRuntime(generator);
    expect(runtime.isolation).toBe('hardened-unattested');
    await expect(
      runtime.generate({ prompt: 'fold', timeoutMs: 1_000, maxOutputBytes: 10_000, remainingCalls: 1 }),
    ).resolves.toMatchObject({
      output: JSON.stringify(emptyCheckpoint),
      providerCalls: 1,
      structured: true,
    });

    expect(harness.startThread).toHaveBeenCalledTimes(1);
    expect(harness.startThread.mock.calls[0][0]).toMatchObject({
      sandboxMode: 'read-only', approvalPolicy: 'never', useBaseConfig: false,
      networkAccessEnabled: false, additionalDirectories: [], dynamicTools: [],
      environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], ephemeral: true,
      configOverrides: { mcp_servers: {} },
    });
    expect(harness.startThread.mock.calls[0][0].workingDirectory)
      .toMatch(/agent-deck-codex-continuation-compactor-/);
    expect(harness.run.mock.calls[0][1]).toMatchObject({
      outputSchema: CONTINUATION_CHECKPOINT_JSON_SCHEMA,
      environments: [],
      runtimeWorkspaceRoots: [],
      maxOutputBytes: 10_000,
    });
    expect(harness.run.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the Codex turn at the checkpoint deadline', async () => {
    let signal: AbortSignal | undefined;
    harness.run.mockImplementation(
      async (_input: unknown, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    );
    const runtime = createCheckpointGeneratorRuntime(generator);
    await expect(
      runtime.generate({ prompt: 'fold', timeoutMs: 5, maxOutputBytes: 10_000, remainingCalls: 1 }),
    ).rejects.toMatchObject({ code: 'timeout', providerCalls: 1 });
    expect(signal?.aborted).toBe(true);
  });
});
