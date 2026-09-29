import { isClaudeThinkingLevel, type ClaudeThinkingLevel } from './session-metadata';

/** Settings layers are ordered from lowest to highest precedence. Environment effort wins. */
export function readClaudeThinkingDefault(records: readonly unknown[]): ClaudeThinkingLevel | undefined {
  let settingsEffort: ClaudeThinkingLevel | undefined;
  let environmentEffort: ClaudeThinkingLevel | 'auto' | undefined;
  for (const value of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (isClaudeThinkingLevel(record.effortLevel)) settingsEffort = record.effortLevel;
    const env = record.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    const effort = (env as Record<string, unknown>).CLAUDE_CODE_EFFORT_LEVEL;
    if (isClaudeThinkingLevel(effort) || effort === 'auto') environmentEffort = effort;
  }
  return environmentEffort === 'auto' ? undefined : environmentEffort ?? settingsEffort;
}
