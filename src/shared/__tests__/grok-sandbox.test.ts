import { describe, expect, it } from 'vitest';
import {
  isGrokBuiltinSandboxProfile,
  normalizeGrokSandboxProfile,
} from '../grok-sandbox';

describe('Grok sandbox profile contract', () => {
  it('accepts built-in and custom profile names after trimming', () => {
    expect(normalizeGrokSandboxProfile(' strict ')).toBe('strict');
    expect(normalizeGrokSandboxProfile('project-locked')).toBe('project-locked');
    expect(isGrokBuiltinSandboxProfile('devbox')).toBe(true);
    expect(isGrokBuiltinSandboxProfile('project-locked')).toBe(false);
  });

  it('rejects empty, overlong, and control-character values', () => {
    expect(() => normalizeGrokSandboxProfile('   ')).toThrow(
      'Grok Build sandbox profile 不能为空。',
    );
    expect(() => normalizeGrokSandboxProfile('x'.repeat(129))).toThrow(
      'Grok Build sandbox profile 不能超过 128 个字符。',
    );
    expect(() => normalizeGrokSandboxProfile('strict\nworkspace')).toThrow(
      'Grok Build sandbox profile 不能包含控制字符。',
    );
  });
});
