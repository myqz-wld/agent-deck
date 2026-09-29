import { describe, expect, it } from 'vitest';
import { readClaudeThinkingDefault } from './claude-config';

describe('Claude thinking defaults', () => {
  it('reads environment-only Gateway effort and gives it precedence over settings effort', () => {
    expect(readClaudeThinkingDefault([
      { env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } },
      { effortLevel: 'low' },
    ])).toBe('max');
  });

  it('merges each setting through the configured layers', () => {
    expect(readClaudeThinkingDefault([{ effortLevel: 'medium' }, { effortLevel: 'xhigh' }])).toBe('xhigh');
    expect(readClaudeThinkingDefault([
      { env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } },
      { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
    ])).toBe('low');
  });

  it('leaves missing, invalid and explicitly automatic effort to the caller fallback', () => {
    expect(readClaudeThinkingDefault([null, [], {}, { effortLevel: 'invalid', env: { CLAUDE_CODE_EFFORT_LEVEL: 'invalid' } }])).toBeUndefined();
    expect(readClaudeThinkingDefault([{ effortLevel: 'low', env: { CLAUDE_CODE_EFFORT_LEVEL: 'auto' } }])).toBeUndefined();
    expect(readClaudeThinkingDefault([{ effortLevel: 'medium', env: { CLAUDE_CODE_EFFORT_LEVEL: 'invalid' } }])).toBe('medium');
  });
});
