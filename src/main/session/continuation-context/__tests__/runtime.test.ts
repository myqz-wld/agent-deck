import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const runGrokOneshot = vi.hoisted(() => vi.fn());
vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: vi.fn(async () => ({ query })),
}));
vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: vi.fn(() => ({ executable: 'node', env: { PATH: '/bin' } })),
}));
vi.mock('@main/adapters/claude-code/resolve-claude-binary', () => ({
  resolveClaudeBinary: vi.fn(() => '/bin/claude'),
}));
vi.mock('@main/adapters/claude-code/gateway-profiles', () => ({
  resolveClaudeGatewayProfile: vi.fn((provider: string | null | undefined) =>
    provider === 'deepseek'
      ? {
          id: 'deepseek',
          settingsPath: '/home/test/.claude/gateways/deepseek.json',
          models: [],
        }
      : null,
  ),
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: vi.fn(() => '/bin/grok') },
}));
vi.mock('@main/session/oneshot-llm', () => ({
  runGrokOneshot,
}));

import { clearGatewayCheckpointCapabilityCache, createCheckpointGeneratorRuntime } from '../runtime';

function iterable(messages: unknown[]): AsyncIterable<unknown> & { interrupt: () => Promise<void> } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    interrupt: vi.fn(async () => undefined),
  };
}

const request = { prompt: 'fold', timeoutMs: 10_000, maxOutputBytes: 10_000, remainingCalls: 4 };

describe('isolated Claude-family checkpoint runtime', () => {
  beforeEach(() => {
    query.mockReset();
    runGrokOneshot.mockReset();
    clearGatewayCheckpointCapabilityCache();
  });

  it('passes an empty tool/MCP surface, one turn, empty settings sources, and structured output', async () => {
    query.mockReturnValueOnce(iterable([
      {
        type: 'result', subtype: 'success', structured_output: {
          formatVersion: 1, additions: [], updates: [],
        },
        usage: { input_tokens: 12, output_tokens: 3 },
        modelUsage: { model: { contextWindow: 200_000 } },
      },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', model: 'claude-test', thinking: 'low',
      contextWindowTokens: null, configFingerprint: 'claude-runtime',
    });
    const result = await runtime.generate(request);
    const call = query.mock.calls[0][0];
    expect(call.options).toMatchObject({
      model: 'claude-test', permissionMode: 'dontAsk', settingSources: [], tools: [],
      mcpServers: {}, maxTurns: 1,
      outputFormat: { type: 'json_schema' },
    });
    expect(call.options.outputFormat.schema).toMatchObject({
      required: ['formatVersion', 'additions', 'updates'],
    });
    expect(call.options.cwd).toMatch(/agent-deck-continuation-compactor-/);
    expect(call.options.cwd).not.toContain('Repository/agent-deck');
    expect(result).toMatchObject({ structured: true, inputTokens: 12, outputTokens: 3, contextWindowTokens: 200_000 });
  });

  it('rejects any observed tool request even though the registry was explicitly empty', async () => {
    query.mockReturnValueOnce(iterable([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/etc/passwd' } }] } },
      { type: 'result', subtype: 'success', structured_output: {} },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', model: null, thinking: 'low', contextWindowTokens: null,
      configFingerprint: 'malicious-runtime',
    });
    await expect(runtime.generate(request)).rejects.toMatchObject({ code: 'tool-use-observed' });
  });

  it('probes Deepseek structured output once, caches incompatibility, and uses JSON-only fallback', async () => {
    const checkpointJson = JSON.stringify({
      formatVersion: 1, additions: [], updates: [],
    });
    query
      .mockReturnValueOnce(iterable([{ type: 'result', subtype: 'error_max_structured_output_retries', modelUsage: {} }]))
      .mockReturnValueOnce(iterable([{ type: 'result', subtype: 'success', result: checkpointJson, usage: {}, modelUsage: {} }]))
      .mockReturnValueOnce(iterable([{ type: 'result', subtype: 'success', result: checkpointJson, usage: {}, modelUsage: {} }]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', provider: 'deepseek', model: 'deepseek-test', thinking: 'max',
      contextWindowTokens: null, configFingerprint: 'deepseek-runtime',
    });
    const first = await runtime.generate(request);
    const second = await runtime.generate(request);
    expect(first.providerCalls).toBe(2);
    expect(second.providerCalls).toBe(1);
    expect(query.mock.calls[0][0].options.outputFormat).toBeDefined();
    expect(query.mock.calls[0][0].options.settings).toBe(
      '/home/test/.claude/gateways/deepseek.json',
    );
    expect(query.mock.calls[1][0].options.outputFormat).toBeUndefined();
    expect(query.mock.calls[2][0].options.outputFormat).toBeUndefined();
  });

  it('runs Grok with the checkpoint schema and hardened-unattested isolation', async () => {
    runGrokOneshot.mockResolvedValue({
      text: JSON.stringify({ formatVersion: 1, additions: [], updates: [] }),
      inputTokens: 17,
      outputTokens: 4,
      contextWindowTokens: 1_048_576,
      stopReason: 'EndTurn',
    });
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'grok-build',
      model: 'fable',
      thinking: 'xhigh',
      contextWindowTokens: null,
      configFingerprint: 'grok-runtime',
    });

    const result = await runtime.generate(request);

    expect(runtime.isolation).toBe('hardened-unattested');
    expect(runGrokOneshot).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'fold',
      model: 'fable',
      effort: 'xhigh',
      binaryPath: '/bin/grok',
      outputSchema: expect.objectContaining({
        required: ['formatVersion', 'additions', 'updates'],
      }),
      maxOutputBytes: 10_000,
    }));
    expect(result).toMatchObject({
      structured: true,
      inputTokens: 17,
      outputTokens: 4,
      contextWindowTokens: 1_048_576,
      providerCalls: 1,
    });
  });
});
