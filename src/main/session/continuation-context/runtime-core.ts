import { rmSync } from 'node:fs';
import { claudeContextWindowObservation } from '@main/adapters/claude-code/sdk-bridge/context-usage-core';
import { resolveClaudeRuntimeModelCore as resolveClaudeRuntimeModel } from '@main/adapters/claude-code/sdk-bridge/runtime-metadata-core';
import type { ClaudeGatewayModelAliases } from '@main/adapters/claude-code/sdk-bridge/types';
import { toCodexAppServerInput } from '@main/adapters/codex-cli/sdk-bridge/input-pack';
import type { JsonObject } from '@main/adapters/codex-cli/app-server/protocol';
import type { CodexAppServerClient } from '@main/adapters/codex-cli/app-server/client';
import type {
  GrokOneshotResult,
  RunGrokOneshotOptions,
} from '@main/session/oneshot-llm/grok-runner';
import {
  isClaudeThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';
import type { ResolvedContinuationGenerator } from './types';
import { CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA } from './checkpoint-patch-schema';
import { CONTINUATION_CHECKPOINT_SYSTEM_PROMPT } from './checkpoint-prompts';
import {
  CheckpointGeneratorError,
  type CheckpointGeneratorRequest,
  type CheckpointGeneratorResult,
  type ContinuationCheckpointGenerator,
} from './checkpoint-generator';
import { utf8ByteLength } from './token-estimator';
import { buildCodexCompactorThreadOptions } from './codex-isolation';

interface ClaudeGatewayRuntimeProfile {
  readonly id: string;
  readonly settingsPath?: string;
  readonly modelAliases: ClaudeGatewayModelAliases;
}

export interface CheckpointGeneratorRuntimeHost {
  loadClaudeSdk(): Promise<{
    query(input: Record<string, unknown>): AsyncIterable<unknown> & {
      interrupt?: () => Promise<unknown>;
    };
  }>;
  claudeRuntimeOptions(): {
    executable: 'node';
    env: Record<string, string | undefined>;
  };
  resolveClaudeBinary(): string | null | undefined;
  resolveClaudeGatewayProfile(provider: string | null): ClaudeGatewayRuntimeProfile | null;
  getCodexInstance(): Promise<Pick<CodexAppServerClient, 'startThread'>>;
  runGrokOneshot(options: RunGrokOneshotOptions): Promise<GrokOneshotResult>;
  grokBinaryPath(): string | null;
  createIsolatedCwd(kind: 'claude' | 'codex'): string;
  releaseCodexInstance?(instance: Pick<CodexAppServerClient, 'startThread'>): void;
}

interface ClaudeRuntimeResult extends Omit<CheckpointGeneratorResult, 'providerCalls'> {
  schemaUnsupported: boolean;
}

const gatewayStructuredOutputCapability = new Map<string, boolean>();

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

async function runClaudeFamilyCheckpoint(input: {
  generator: ResolvedContinuationGenerator;
  request: CheckpointGeneratorRequest;
  structured: boolean;
  settingsPath?: string;
  runtimeProvider: string;
  gatewayModelAliases?: ClaudeGatewayModelAliases;
}, host: CheckpointGeneratorRuntimeHost): Promise<ClaudeRuntimeResult> {
  if (input.request.remainingCalls < 1) {
    throw new CheckpointGeneratorError('No checkpoint generator calls remain', 'provider-error');
  }
  if (input.request.signal?.aborted) {
    throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  }
  const sdk = await host.loadClaudeSdk();
  const runtime = host.claudeRuntimeOptions();
  const claudeBinary = host.resolveClaudeBinary();
  const cwd = host.createIsolatedCwd('claude');
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
        ...(input.settingsPath ? { settings: input.settingsPath } : {}),
        tools: [],
        mcpServers: {},
        maxTurns: 1,
        ...(input.structured
          ? {
              outputFormat: {
                type: 'json_schema' as const,
                schema: CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA,
              },
            }
          : {}),
        executable: runtime.executable,
        env: { ...runtime.env },
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });
    const work = (async (): Promise<ClaudeRuntimeResult> => {
      let assistantText = '';
      let primaryModel = resolveClaudeRuntimeModel(
        input.generator.model,
        input.gatewayModelAliases,
      );
      for await (const message of q) {
        const current = message as Record<string, unknown>;
        if (current.type === 'system' && current.subtype === 'init') {
          primaryModel =
            resolveClaudeRuntimeModel(current.model, input.gatewayModelAliases) ??
            primaryModel;
        }
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
        const capacity = claudeContextWindowObservation(
          current.modelUsage as Record<
            string,
            { contextWindow?: number; canonicalModel?: string }
          > | null | undefined,
          primaryModel,
          input.gatewayModelAliases,
        );
        const contextWindowEvidence = capacity
          ? {
              runtimeProvider: input.runtimeProvider,
              model: capacity.model,
              windowTokens: capacity.windowTokens,
              source: 'runtime-usage' as const,
            }
          : null;
        const subtype = current.subtype;
        if (subtype === 'error_max_structured_output_retries') {
          return {
            output: '',
            rawText: assistantText,
            inputTokens: null,
            outputTokens: null,
            contextWindowTokens: capacity?.windowTokens ?? null,
            contextWindowEvidence,
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
          contextWindowTokens: capacity?.windowTokens ?? null,
          contextWindowEvidence,
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

  constructor(
    private readonly generator: ResolvedContinuationGenerator,
    private readonly host: CheckpointGeneratorRuntimeHost,
  ) {}

  async generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> {
    const deadlineAt = request.timeoutMs > 0 ? performance.now() + request.timeoutMs : null;
    const profile = this.host.resolveClaudeGatewayProfile(this.generator.provider ?? null);
    const usesGateway = profile !== null;
    const fingerprint = this.generator.configFingerprint;
    const cached = usesGateway
      ? gatewayStructuredOutputCapability.get(fingerprint)
      : undefined;
    const first = await runClaudeFamilyCheckpoint({
      generator: this.generator,
      request,
      structured: cached !== false,
      settingsPath: profile?.settingsPath,
      runtimeProvider: profile?.id ?? 'native',
      gatewayModelAliases: profile?.modelAliases,
    }, this.host);
    if (!first.schemaUnsupported) {
      if (usesGateway && cached === undefined && first.structured) {
        gatewayStructuredOutputCapability.set(fingerprint, true);
      }
      const { schemaUnsupported: _ignored, ...result } = first;
      return { ...result, providerCalls: 1 };
    }
    if (usesGateway) gatewayStructuredOutputCapability.set(fingerprint, false);
    if (request.remainingCalls < 2) {
      throw new CheckpointGeneratorError(
        'Structured output unsupported and no JSON-only fallback call remains',
        'schema-unsupported',
        1,
      );
    }
    const remainingMs = deadlineAt === null
      ? request.timeoutMs
      : Math.max(0, deadlineAt - performance.now());
    if (deadlineAt !== null && remainingMs === 0) {
      throw new CheckpointGeneratorError(
        'Checkpoint generation timed out before the JSON-only fallback',
        'timeout',
        1,
      );
    }
    let fallback: ClaudeRuntimeResult;
    try {
      fallback = await runClaudeFamilyCheckpoint({
        generator: this.generator,
        request: {
          ...request,
          timeoutMs: remainingMs,
          remainingCalls: request.remainingCalls - 1,
        },
        structured: false,
        settingsPath: profile?.settingsPath,
        runtimeProvider: profile?.id ?? 'native',
        gatewayModelAliases: profile?.modelAliases,
      }, this.host);
    } catch (error) {
      if (error instanceof CheckpointGeneratorError) {
        throw new CheckpointGeneratorError(error.message, error.code, error.providerCalls + 1);
      }
      throw error;
    }
    const { schemaUnsupported: _ignored, ...result } = fallback;
    return { ...result, providerCalls: 2 };
  }
}

async function runCodexCheckpoint(input: {
  generator: ResolvedContinuationGenerator;
  request: CheckpointGeneratorRequest;
}, host: CheckpointGeneratorRuntimeHost): Promise<CheckpointGeneratorResult> {
  if (input.request.remainingCalls < 1) {
    throw new CheckpointGeneratorError('No checkpoint generator calls remain', 'provider-error');
  }
  if (input.request.signal?.aborted) {
    throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  }

  const cwd = host.createIsolatedCwd('codex');
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | null = null;
  let timedOut = false;
  let codex: Pick<CodexAppServerClient, 'startThread'> | null = null;
  const abort = () => controller.abort();
  input.request.signal?.addEventListener('abort', abort, { once: true });
  try {
    codex = await host.getCodexInstance();
    const thread = codex.startThread(
      buildCodexCompactorThreadOptions({
        generator: input.generator,
        emptyWorkingDirectory: cwd,
      }),
    );
    const work = thread.run(toCodexAppServerInput(input.request.prompt), {
      signal: controller.signal,
      outputSchema: CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA as unknown as JsonObject,
      environments: [],
      runtimeWorkspaceRoots: [],
      maxOutputBytes: input.request.maxOutputBytes,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      if (input.request.timeoutMs <= 0) return;
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new CheckpointGeneratorError('Checkpoint generation timed out', 'timeout', 1));
        controller.abort();
      }, input.request.timeoutMs);
    });
    const result =
      input.request.timeoutMs > 0
        ? await Promise.race([work, timeoutPromise])
        : await work;
    const checked = checkedOutput(result.finalResponse, input.request.maxOutputBytes);
    return {
      ...checked,
      inputTokens: null,
      outputTokens: null,
      contextWindowTokens: result.contextWindowEvidence?.windowTokens ?? null,
      contextWindowEvidence: result.contextWindowEvidence,
      latencyMs: Date.now() - startedAt,
      providerCalls: 1,
      structured: true,
    };
  } catch (error) {
    if (error instanceof CheckpointGeneratorError) throw error;
    if (timedOut) {
      throw new CheckpointGeneratorError('Checkpoint generation timed out', 'timeout', 1);
    }
    if (input.request.signal?.aborted || controller.signal.aborted) {
      throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted', 1);
    }
    if (error instanceof Error && error.message.includes('output exceeded byte limit')) {
      throw new CheckpointGeneratorError(error.message, 'output-too-large', 1);
    }
    throw new CheckpointGeneratorError(
      error instanceof Error ? error.message : String(error),
      'provider-error',
      1,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    input.request.signal?.removeEventListener('abort', abort);
    if (codex) host.releaseCodexInstance?.(codex);
    rmSync(cwd, { recursive: true, force: true });
  }
}

class HardenedCodexCheckpointGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'hardened-unattested' as const;

  constructor(
    private readonly generator: ResolvedContinuationGenerator,
    private readonly host: CheckpointGeneratorRuntimeHost,
  ) {}

  generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> {
    return runCodexCheckpoint({ generator: this.generator, request }, this.host);
  }
}

async function runGrokCheckpoint(input: {
  generator: ResolvedContinuationGenerator;
  request: CheckpointGeneratorRequest;
}, host: CheckpointGeneratorRuntimeHost): Promise<CheckpointGeneratorResult> {
  if (input.request.remainingCalls < 1) {
    throw new CheckpointGeneratorError('No checkpoint generator calls remain', 'provider-error');
  }
  if (input.request.signal?.aborted) {
    throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  }
  const startedAt = Date.now();
  try {
    const result = await host.runGrokOneshot({
      prompt: input.request.prompt,
      systemPrompt: CONTINUATION_CHECKPOINT_SYSTEM_PROMPT,
      ...(input.generator.model ? { model: input.generator.model } : {}),
      ...(isGrokThinkingLevel(input.generator.thinking)
        ? { effort: input.generator.thinking }
        : {}),
      binaryPath: host.grokBinaryPath(),
      outputSchema: CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA,
      maxOutputBytes: input.request.maxOutputBytes,
      timeoutMs: input.request.timeoutMs,
      timeoutErrorMessage: 'Checkpoint generation timed out',
      ...(input.request.signal ? { signal: input.request.signal } : {}),
    });
    const checked = checkedOutput(result.text, input.request.maxOutputBytes);
    return {
      ...checked,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextWindowTokens: result.contextWindowTokens,
      latencyMs: Date.now() - startedAt,
      providerCalls: 1,
      structured: true,
    };
  } catch (error) {
    if (error instanceof CheckpointGeneratorError) throw error;
    if (input.request.signal?.aborted) {
      throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted', 1);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timed out')) {
      throw new CheckpointGeneratorError(message, 'timeout', 1);
    }
    if (message.includes('exceeded') && message.includes('bytes')) {
      throw new CheckpointGeneratorError(message, 'output-too-large', 1);
    }
    throw new CheckpointGeneratorError(message, 'provider-error', 1);
  }
}

class HardenedGrokCheckpointGenerator implements ContinuationCheckpointGenerator {
  readonly isolation = 'hardened-unattested' as const;

  constructor(
    private readonly generator: ResolvedContinuationGenerator,
    private readonly host: CheckpointGeneratorRuntimeHost,
  ) {}

  generate(request: CheckpointGeneratorRequest): Promise<CheckpointGeneratorResult> {
    return runGrokCheckpoint({ generator: this.generator, request }, this.host);
  }
}

export function createCheckpointGeneratorRuntime(
  generator: ResolvedContinuationGenerator,
  host: CheckpointGeneratorRuntimeHost,
): ContinuationCheckpointGenerator {
  switch (generator.adapter) {
    case 'codex-cli':
      return new HardenedCodexCheckpointGenerator(generator, host);
    case 'grok-build':
      return new HardenedGrokCheckpointGenerator(generator, host);
    default:
      return new ClaudeFamilyCheckpointGenerator(generator, host);
  }
}

export function clearGatewayCheckpointCapabilityCache(): void {
  gatewayStructuredOutputCapability.clear();
}
