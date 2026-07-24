import { describe, expect, it } from 'vitest';
import {
  normalizeBundledAgentRuntimeOverride,
  normalizeBundledAgentRuntimeOverrideMap,
} from '@main/bundled-agent-runtime-validation';

describe('bundled Agent runtime override validation', () => {
  it('normalizes supported model, thinking, and Codex provider fields', () => {
    expect(
      normalizeBundledAgentRuntimeOverride('codex-cli', {
        model: '  qw-pro-5 ',
        thinking: 'high',
        provider: ' fable ',
      }),
    ).toEqual({
      model: 'qw-pro-5',
      thinking: 'high',
      provider: 'fable',
    });
  });

  it('keeps adapter-specific thinking levels and provider boundaries', () => {
    expect(() =>
      normalizeBundledAgentRuntimeOverride('grok-build', { thinking: 'xhigh' }),
    ).toThrow('not valid for grok-build');
    expect(() =>
      normalizeBundledAgentRuntimeOverride('claude-code', { provider: 'fable' }),
    ).toThrow('only for codex-cli');
  });

  it('rejects unknown fields and malformed persisted keys', () => {
    expect(() =>
      normalizeBundledAgentRuntimeOverride('codex-cli', { tools: 'Bash' }),
    ).toThrow('unknown override field');
    expect(() =>
      normalizeBundledAgentRuntimeOverrideMap({
        'codex-cli:../reviewer': { model: 'gpt-5.5' },
      }),
    ).toThrow('invalid bundled Agent override key');
  });

  it('drops empty records while preserving valid adapter:name entries', () => {
    expect(
      normalizeBundledAgentRuntimeOverrideMap({
        'claude-code:reviewer-claude': {},
        'grok-build:reviewer-grok': { model: 'grok-4.5', thinking: 'high' },
      }),
    ).toEqual({
      'grok-build:reviewer-grok': { model: 'grok-4.5', thinking: 'high' },
    });
  });
});
