export const CLAUDE_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_THINKING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export const GROK_THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export const SESSION_THINKING_LEVELS = CODEX_THINKING_LEVELS;

export type ClaudeThinkingLevel = (typeof CLAUDE_THINKING_LEVELS)[number];
export type CodexThinkingLevel = (typeof CODEX_THINKING_LEVELS)[number];
export type GrokThinkingLevel = (typeof GROK_THINKING_LEVELS)[number];

export function isGrokThinkingLevel(value: unknown): value is GrokThinkingLevel {
  return GROK_THINKING_LEVELS.includes(value as GrokThinkingLevel);
}
/** Retained only to read pre-removal persisted settings and session metadata. */
export type LegacySessionThinkingLevel = 'minimal';
export type SessionThinkingLevel =
  | (typeof SESSION_THINKING_LEVELS)[number]
  | LegacySessionThinkingLevel;

export function isClaudeThinkingLevel(value: unknown): value is ClaudeThinkingLevel {
  return typeof value === 'string' && (CLAUDE_THINKING_LEVELS as readonly string[]).includes(value);
}

export function isCodexThinkingLevel(value: unknown): value is CodexThinkingLevel {
  return typeof value === 'string' && (CODEX_THINKING_LEVELS as readonly string[]).includes(value);
}

export function isSessionThinkingLevel(value: unknown): value is SessionThinkingLevel {
  return isClaudeThinkingLevel(value) || isCodexThinkingLevel(value);
}

export function formatThinkingLevel(value: string | null | undefined): string {
  if (!value) return 'default';
  switch (value) {
    case 'minimal':
      // Historical session rows can retain the removed value for display only.
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    case 'ultra':
      return 'ultra';
    default:
      return value;
  }
}
