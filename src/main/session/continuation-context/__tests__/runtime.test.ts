import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const runGrokOneshot = vi.hoisted(() => vi.fn());
const codexRuntime = vi.hoisted(() => ({
  run: vi.fn(),
  startThread: vi.fn(),
}));
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
          modelAliases: { sonnet: 'deepseek-test' },
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
vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  getCodexInstance: vi.fn(async () => ({
    startThread: codexRuntime.startThread,
  })),
}));

import { clearGatewayCheckpointCapabilityCache, createCheckpointGeneratorRuntime } from '../runtime';
import { unknownContextCapacity } from './capacity-fixtures';

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
        modelUsage: { 'claude-test': { contextWindow: 200_000 } },
      },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', model: 'claude-test', thinking: 'low',
      contextCapacity: unknownContextCapacity(), configFingerprint: 'claude-runtime',
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
    expect(result).toMatchObject({
      structured: true,
      inputTokens: 12,
      outputTokens: 3,
      contextWindowTokens: 200_000,
      contextWindowEvidence: {
        runtimeProvider: 'native',
        model: 'claude-test',
        windowTokens: 200_000,
        source: 'runtime-usage',
      },
    });
  });

  it('does not attribute an ambiguous multi-model result to the configured primary', async () => {
    query.mockReturnValueOnce(iterable([
      {
        type: 'result', subtype: 'success', structured_output: {
          formatVersion: 1, additions: [], updates: [],
        },
        modelUsage: {
          'claude-opus-4-7': { contextWindow: 200_000 },
          'claude-haiku-4-5': { contextWindow: 200_000 },
        },
      },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', model: 'claude-opus-4-8', thinking: 'low',
      contextCapacity: unknownContextCapacity(), configFingerprint: 'ambiguous-claude-runtime',
    });

    const result = await runtime.generate(request);

    expect(result.contextWindowTokens).toBeNull();
    expect(result.contextWindowEvidence).toBeNull();
  });

  it('uses authoritative Gateway alias metadata for checkpoint capacity identity', async () => {
    query.mockReturnValueOnce(iterable([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' },
      {
        type: 'result', subtype: 'success', structured_output: {
          formatVersion: 1, additions: [], updates: [],
        },
        modelUsage: {
          'claude-sonnet-4-5': {
            contextWindow: 1_000_000,
          },
          'claude-haiku-4-5': { contextWindow: 128_000 },
        },
      },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', provider: 'deepseek', model: 'sonnet', thinking: 'max',
      contextCapacity: unknownContextCapacity(), configFingerprint: 'gateway-capacity-runtime',
    });

    const result = await runtime.generate(request);

    expect(result).toMatchObject({
      contextWindowTokens: 1_000_000,
      contextWindowEvidence: {
        runtimeProvider: 'deepseek',
        model: 'deepseek-test',
        windowTokens: 1_000_000,
        source: 'runtime-usage',
      },
    });
  });

  it('rejects any observed tool request even though the registry was explicitly empty', async () => {
    query.mockReturnValueOnce(iterable([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/etc/passwd' } }] } },
      { type: 'result', subtype: 'success', structured_output: {} },
    ]));
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'claude-code', model: null, thinking: 'low',
      contextCapacity: unknownContextCapacity(),
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
      contextCapacity: unknownContextCapacity(), configFingerprint: 'deepseek-runtime',
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
      contextCapacity: unknownContextCapacity(),
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

describe('isolated Codex checkpoint runtime', () => {
  beforeEach(() => {
    codexRuntime.run.mockReset();
    codexRuntime.startThread.mockReset();
    codexRuntime.startThread.mockReturnValue({ run: codexRuntime.run });
  });

  it('returns exact native provider/model capacity evidence without a headroom adjustment', async () => {
    codexRuntime.run.mockResolvedValue({
      finalResponse: JSON.stringify({ formatVersion: 1, additions: [], updates: [] }),
      contextWindowEvidence: {
        runtimeProvider: 'openrouter',
        model: 'gpt-5.6-sol-effective',
        windowTokens: 272_000,
        source: 'runtime-usage',
      },
    });
    const runtime = createCheckpointGeneratorRuntime({
      adapter: 'codex-cli',
      provider: 'openrouter',
      model: 'gpt-5.6-sol',
      thinking: 'high',
      contextCapacity: unknownContextCapacity(),
      configFingerprint: 'codex-runtime',
    });

    const result = await runtime.generate(request);

    expect(codexRuntime.startThread).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      configOverrides: expect.objectContaining({ model_provider: 'openrouter' }),
    }));
    expect(result).toMatchObject({
      contextWindowTokens: 272_000,
      contextWindowEvidence: {
        runtimeProvider: 'openrouter',
        model: 'gpt-5.6-sol-effective',
        windowTokens: 272_000,
        source: 'runtime-usage',
      },
    });
  });
});
