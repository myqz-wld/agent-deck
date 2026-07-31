import { describe, expect, it } from 'vitest';
import {
  normalizeBundledAgentRuntimeOverride,
  normalizeBundledAgentRuntimeOverrideMap,
} from '@main/bundled-agent-runtime-validation';

function errorMessage(run: () => unknown): string {
  try {
    run();
    throw new Error('expected validation to fail');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}

describe('bundled Agent runtime override validation', () => {
  it('normalizes supported model, thinking, and Codex model_provider fields', () => {
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
    expect(
      normalizeBundledAgentRuntimeOverride('grok-build', { thinking: 'xhigh' }),
    ).toEqual({ thinking: 'xhigh' });
    expect(
      normalizeBundledAgentRuntimeOverride('claude-code', {
        provider: ' deepseek ',
      }),
    ).toEqual({ provider: 'deepseek' });
    expect(
      errorMessage(() =>
        normalizeBundledAgentRuntimeOverride('grok-build', {
          provider: 'fable',
        }),
      ),
    ).toBe('provider 仅适用于 Claude Code 或 Codex CLI 的内置 Agent');
    expect(
      errorMessage(() =>
        normalizeBundledAgentRuntimeOverride('grok-build', {
          thinking: 'max',
        }),
      ),
    ).toBe('thinking "max" 对 Grok Build 无效');
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
