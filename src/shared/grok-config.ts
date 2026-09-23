import { parse } from '@iarna/toml';

/** Read native Grok defaults without interpreting custom endpoints or credentials. */
export function readGrokModelDefaults(content: string | null): {
  model: string | null;
  thinking: string | null;
} {
  const result = { model: null, thinking: null };
  if (!content) return result;
  try {
    const models = parse(content).models;
    if (!models || typeof models !== 'object' || Array.isArray(models) || models instanceof Date) {
      return result;
    }
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    return { model: text(models.default), thinking: text(models.default_reasoning_effort) };
  } catch {
    return result;
  }
}
