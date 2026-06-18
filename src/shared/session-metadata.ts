export const CLAUDE_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ClaudeThinkingLevel = (typeof CLAUDE_THINKING_LEVELS)[number];
export type CodexThinkingLevel = (typeof CODEX_THINKING_LEVELS)[number];

export function isClaudeThinkingLevel(value: unknown): value is ClaudeThinkingLevel {
  return typeof value === 'string' && (CLAUDE_THINKING_LEVELS as readonly string[]).includes(value);
}

export function isCodexThinkingLevel(value: unknown): value is CodexThinkingLevel {
  return typeof value === 'string' && (CODEX_THINKING_LEVELS as readonly string[]).includes(value);
}

export function isSessionThinkingLevel(value: unknown): value is ClaudeThinkingLevel | CodexThinkingLevel {
  return isClaudeThinkingLevel(value) || isCodexThinkingLevel(value);
}

export function formatThinkingLevel(value: string | null | undefined): string {
  if (!value) return 'default';
  switch (value) {
    case 'minimal':
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
    default:
      return value;
  }
}
