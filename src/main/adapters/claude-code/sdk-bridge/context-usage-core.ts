import type { ClaudeGatewayModelAliases, InternalSession } from './types';
import { resolveClaudeRuntimeModelCore } from './runtime-metadata-core';

interface ClaudeAssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface ClaudeModelUsage {
  contextWindow?: number;
  /** SDK pricing lookup metadata; never authoritative runtime-entry ownership. */
  canonicalModel?: string;
}

export interface ClaudeContextWindowObservation {
  model: string;
  windowTokens: number;
}

export function claudeContextUsagePayload(
  internal: InternalSession,
  payload: Record<string, unknown>,
  model = internal.runtimeModel,
): Record<string, unknown> {
  const concreteModel = model?.trim();
  return concreteModel && !isAliasOnly(concreteModel)
    ? {
        ...payload,
        runtimeIdentity: {
          runtimeProvider: internal.runtimeProvider,
          model: concreteModel,
        },
      }
    : payload;
}

export function claudeAssistantContextTokens(
  usage: ClaudeAssistantUsage | null | undefined,
): number | null {
  const input = tokenCount(usage?.input_tokens);
  const output = tokenCount(usage?.output_tokens);
  if (input === null || output === null) return null;
  return (
    input +
    output +
    (tokenCount(usage?.cache_creation_input_tokens) ?? 0) +
    (tokenCount(usage?.cache_read_input_tokens) ?? 0)
  );
}

/**
 * Attribute a finalized window only to the exact SDK-initialized primary model.
 * modelUsage may include fallback/subagent entries, so bucket matching and equal-window collapse
 * are intentionally forbidden.
 */
export function claudeContextWindowObservation(
  modelUsage: Record<string, ClaudeModelUsage> | null | undefined,
  primaryModel: string | null | undefined,
  gatewayModelAliases?: ClaudeGatewayModelAliases,
): ClaudeContextWindowObservation | null {
  const entries = Object.entries(modelUsage ?? {})
    .map(([model, usage]) => ({
      model: model.trim(),
      mappedModel: resolveClaudeRuntimeModelCore(model, gatewayModelAliases),
      windowTokens: positiveTokenCount(usage.contextWindow),
    }))
    .filter(
      (entry): entry is typeof entry & { windowTokens: number } =>
        entry.model.length > 0 && entry.windowTokens !== null,
    );
  if (entries.length === 0) return null;
  const primary = nonBlank(primaryModel);
  if (!primary) return null;
  const exact = entries.filter(
    (entry) => entry.model === primary || entry.mappedModel === primary,
  );
  if (exact.length !== 1 || isAliasOnly(primary)) return null;
  return { model: primary, windowTokens: exact[0].windowTokens };
}

export function claudeContextWindowPayload(
  internal: InternalSession,
  modelUsage: Record<string, ClaudeModelUsage> | null | undefined,
): Record<string, unknown> | null {
  const observation = claudeContextWindowObservation(
    modelUsage,
    internal.runtimeModel,
    internal.gatewayModelAliases,
  );
  return observation
    ? claudeContextUsagePayload(
        internal,
        {
          windowTokens: observation.windowTokens,
          capacitySource: 'runtime-usage',
        },
        observation.model,
      )
    : null;
}

function isAliasOnly(model: string): boolean {
  return /^(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-latest)?$/i.test(model);
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function positiveTokenCount(value: unknown): number | null {
  const parsed = tokenCount(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
