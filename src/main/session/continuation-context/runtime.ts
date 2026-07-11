import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { resolveClaudeBinary } from '@main/adapters/claude-code/resolve-claude-binary';
import { loadDeepseekClaudeEnv } from '@main/adapters/deepseek-claude-code/config';
import { isClaudeThinkingLevel } from '@shared/session-metadata';
import type { ResolvedContinuationGenerator } from './types';
import { CONTINUATION_CHECKPOINT_JSON_SCHEMA } from './checkpoint-schema';
import { CONTINUATION_CHECKPOINT_SYSTEM_PROMPT } from './checkpoint-prompts';
import {
  CheckpointGeneratorError,
  type CheckpointGeneratorRequest,
  type CheckpointGeneratorResult,
  type ContinuationCheckpointGenerator,
} from './checkpoint-generator';
import { utf8ByteLength } from './token-estimator';
import { codexCompactorIsolationAttestation } from './codex-isolation';

interface ClaudeRuntimeResult extends Omit<CheckpointGeneratorResult, 'providerCalls'> {
  schemaUnsupported: boolean;
}

const deepseekStructuredOutputCapability = new Map<string, boolean>();

function checkedOutput(value: unknown, maxBytes: number): { output: unknown; rawText: string } {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized === undefined) {
    throw new CheckpointGeneratorError('Checkpoint generator returned no output', 'provider-error', 1);
  }
  const rawText = serialized;
  if (utf8ByteLength(rawText) > maxBytes) {
    throw new CheckpointGeneratorError('Checkpoint generator output exceeded byte limit', 'output-too-large', 1);
  }
  return { output: value, rawText };
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function contextWindow(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const windows = Object.values(modelUsage as Record<string, unknown>)
    .map((entry) =>
      entry && typeof entry === 'object'
        ? usageNumber((entry as Record<string, unknown>).contextWindow)
        : null,
    )
    .filter((entry): entry is number => entry !== null);
  return windows.length > 0 ? Math.min(...windows) : null;
}

async function runClaudeFamilyCheckpoint(input: {
  generator: ResolvedContinuationGenerator;
  request: CheckpointGeneratorRequest;
  structured: boolean;
  envOverride?: Readonly<Record<string, string>>;
}): Promise<ClaudeRuntimeResult> {
  if (input.request.remainingCalls < 1) {
    throw new CheckpointGeneratorError('No checkpoint generator calls remain', 'provider-error');
  }
  if (input.request.signal?.aborted) {
    throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  }
  const sdk = await loadSdk();
  const runtime = getSdkRuntimeOptions();
  const claudeBinary = resolveClaudeBinary();
  const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-continuation-compactor-'));
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;
  const abort = () => controller.abort();
  input.request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const q = sdk.query({
      prompt: input.structured
        ? input.request.prompt
        : `${input.request.prompt}\n\nStructured output is unavailable. Return one JSON value only.`,
      options: {
        cwd,
        ...(input.generator.model ? { model: input.generator.model } : {}),
        ...(isClaudeThinkingLevel(input.generator.thinking)
          ? { effort: input.generator.thinking }
          : {}),
        abortController: controller,
        permissionMode: 'dontAsk',
        systemPrompt: CONTINUATION_CHECKPOINT_SYSTEM_PROMPT,
        settingSources: [],
        tools: [],
        mcpServers: {},
        maxTurns: 1,
        ...(input.structured
          ? {
              outputFormat: {
                type: 'json_schema' as const,
                schema: CONTINUATION_CHECKPOINT_JSON_SCHEMA,
              },
            }
          : {}),
        executable: runtime.executable,
        env: { ...runtime.env, ...(input.envOverride ?? {}) },
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });
    const work = (async (): Promise<ClaudeRuntimeResult> => {
      let assistantText = '';
      for await (const message of q) {
        const current = message as Record<string, unknown>;
        if (current.type === 'assistant') {
          const content = (current.message as { content?: Array<Record<string, unknown>> } | undefined)?.content;
          for (const block of content ?? []) {
            if (block.type === 'tool_use') {
              throw new CheckpointGeneratorError(
                'Isolated checkpoint runtime observed a tool request',
                'tool-use-observed',
                1,
              );
            }
            if (block.type === 'text' && typeof block.text === 'string') {
              assistantText += block.text;
              if (utf8ByteLength(assistantText) > input.request.maxOutputBytes) {
                throw new CheckpointGeneratorError(
                  'Checkpoint generator output exceeded byte limit',
                  'output-too-large',
                  1,
                );
              }
            }
          }
        }
        if (current.type !== 'result') continue;
        const subtype = current.subtype;
        if (subtype === 'error_max_structured_output_retries') {
          return {
            output: '',
            rawText: assistantText,
            inputTokens: null,
            outputTokens: null,
            contextWindowTokens: contextWindow(current.modelUsage),
            latencyMs: Date.now() - startedAt,
            structured: input.structured,
            schemaUnsupported: true,
          };
        }
        if (subtype !== 'success') {
          throw new CheckpointGeneratorError(
            `Checkpoint provider failed: ${String(subtype)}`,
            'provider-error',
            1,
          );
        }
        const usage = current.usage as Record<string, unknown> | undefined;
        const value = input.structured ? current.structured_output : current.result ?? assistantText;
        const checked = checkedOutput(value, input.request.maxOutputBytes);
        return {
          ...checked,
          inputTokens: usageNumber(usage?.input_tokens),
          outputTokens: usageNumber(usage?.output_tokens),
          contextWindowTokens: contextWindow(current.modelUsage),
          latencyMs: Date.now() - startedAt,
          structured: input.structured,
          schemaUnsupported: false,
        };
      }
      throw new CheckpointGeneratorError('Checkpoint provider returned no result', 'provider-error', 1);
    })();
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (input.request.timeoutMs <= 0) return;
      timeout = setTimeout(() => {
        controller.abort();
        void q.interrupt?.().catch(() => undefined);
        reject(new CheckpointGeneratorError('Checkpoint generation timed out', 'timeout', 1));
      }, input.request.timeoutMs);
    });
    return input.request.timeoutMs > 0 ? await Promise.race([work, timeoutPromise]) : await work;
  } catch (error) {
    if (error instanceof CheckpointGeneratorError) throw error;
    if (controller.signal.aborted) {
      throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted', 1);
    }
    throw new CheckpointGeneratorError(
      error instanceof Error ? error.message : String(error),
      'provider-error',
      1,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    input.request.signal?.removeEventListener('abort', abort);
    rmSync(cwd, { recursive: true, force: true });
  }
}

class ClaudeFamilyCheckpointGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'proven-no-tools' as const;

  constructor(private readonly generator: ResolvedContinuationGenerator) {}

  async generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> {
    const isDeepseek = this.generator.adapter === 'deepseek-claude-code';
    const fingerprint = this.generator.configFingerprint;
    const cached = isDeepseek ? deepseekStructuredOutputCapability.get(fingerprint) : undefined;
    const envOverride = isDeepseek ? loadDeepseekClaudeEnv() : undefined;
    const first = await runClaudeFamilyCheckpoint({
      generator: this.generator,
      request,
      structured: cached !== false,
      envOverride,
    });
    if (!first.schemaUnsupported) {
      if (isDeepseek && cached === undefined && first.structured) {
        deepseekStructuredOutputCapability.set(fingerprint, true);
      }
      const { schemaUnsupported: _ignored, ...result } = first;
      return { ...result, providerCalls: 1 };
    }
    if (isDeepseek) deepseekStructuredOutputCapability.set(fingerprint, false);
    if (request.remainingCalls < 2) {
      throw new CheckpointGeneratorError(
        'Structured output unsupported and no JSON-only fallback call remains',
        'schema-unsupported',
        1,
      );
    }
    const fallback = await runClaudeFamilyCheckpoint({
      generator: this.generator,
      request: { ...request, remainingCalls: request.remainingCalls - 1 },
      structured: false,
      envOverride,
    });
    const { schemaUnsupported: _ignored, ...result } = fallback;
    return { ...result, providerCalls: 2 };
  }
}

class FailClosedCodexCheckpointGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'fail-closed' as const;

  async generate(): Promise<CheckpointGeneratorResult> {
    const attestation = codexCompactorIsolationAttestation();
    throw new CheckpointGeneratorError(
      attestation.reason,
      'codex-generator-tools-unproven',
    );
  }
}

export function createCheckpointGeneratorRuntime(
  generator: ResolvedContinuationGenerator,
): ContinuationCheckpointGenerator {
  return generator.adapter === 'codex-cli'
    ? new FailClosedCodexCheckpointGenerator()
    : new ClaudeFamilyCheckpointGenerator(generator);
}

export function clearDeepseekCheckpointCapabilityCache(): void {
  deepseekStructuredOutputCapability.clear();
}
