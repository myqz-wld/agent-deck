import { describe, expect, it } from 'vitest';
import {
  CODEX_THINKING_LEVELS,
  SESSION_THINKING_LEVELS,
  formatThinkingLevel,
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
} from '../session-metadata';

describe('session-metadata thinking levels', () => {
  it('keeps provider-specific max and ultra support separate while rejecting removed minimal', () => {
    expect(CODEX_THINKING_LEVELS).toContain('max');
    expect(CODEX_THINKING_LEVELS).toContain('ultra');
    expect(SESSION_THINKING_LEVELS).toContain('ultra');
    expect(isCodexThinkingLevel('ultra')).toBe(true);
    expect(isClaudeThinkingLevel('ultra')).toBe(false);
    expect(CODEX_THINKING_LEVELS).not.toContain('minimal');
    expect(isCodexThinkingLevel('minimal')).toBe(false);
  });

  it('formats concrete and historical display values', () => {
    expect(formatThinkingLevel('ultra')).toBe('ultra');
    expect(formatThinkingLevel('minimal')).toBe('minimal');
  });
});
