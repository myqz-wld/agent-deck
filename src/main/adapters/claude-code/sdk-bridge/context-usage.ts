import { normalizeModel } from '@shared/model-normalize';

interface ClaudeAssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface ClaudeModelUsage {
  contextWindow?: number;
  canonicalModel?: string;
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

export function claudeContextWindowTokens(
  modelUsage: Record<string, ClaudeModelUsage> | null | undefined,
  preferredModel: string | null | undefined,
): number | null {
  const entries = Object.entries(modelUsage ?? {})
    .map(([model, usage]) => ({
      model,
      canonicalModel: usage.canonicalModel,
      windowTokens: positiveTokenCount(usage.contextWindow),
    }))
    .filter(
      (entry): entry is typeof entry & { windowTokens: number } =>
        entry.windowTokens !== null,
    );
  if (entries.length === 0) return null;
  const preferred = preferredModel?.trim();
  if (preferred) {
    const exact = entries.find(
      (entry) =>
        entry.model === preferred || entry.canonicalModel === preferred,
    );
    if (exact) return exact.windowTokens;
    const bucket = normalizeModel(preferred).bucketKey;
    const matches = entries.filter(
      (entry) =>
        normalizeModel(entry.model).bucketKey === bucket ||
        normalizeModel(entry.canonicalModel).bucketKey === bucket,
    );
    if (matches.length === 1) return matches[0].windowTokens;
  }
  if (entries.length === 1) return entries[0].windowTokens;
  const distinct = new Set(entries.map((entry) => entry.windowTokens));
  return distinct.size === 1 ? entries[0].windowTokens : null;
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
