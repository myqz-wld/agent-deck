import { describe, expect, it } from 'vitest';
import {
  firstUnsupportedTargetRuntimeField,
  targetRuntimeFieldsForAdapter,
} from '../runtime-control-contracts';

describe('adapter target runtime control contracts', () => {
  it('keeps Claude, Codex, and Grok provider-native controls separate', () => {
    expect(targetRuntimeFieldsForAdapter('claude-code')).toEqual([
      'provider',
      'model',
      'thinking',
      'permissionMode',
      'claudeCodeSandbox',
      'extraAllowWrite',
    ]);
    expect(targetRuntimeFieldsForAdapter('codex-cli')).toEqual([
      'provider',
      'model',
      'thinking',
      'codexSandbox',
      'extraAllowWrite',
    ]);
    expect(targetRuntimeFieldsForAdapter('grok-build')).toEqual([
      'model',
      'thinking',
      'sessionMode',
      'grokSandbox',
    ]);
  });

  it('finds explicit incompatible controls instead of allowing silent filtering', () => {
    expect(firstUnsupportedTargetRuntimeField('claude-code', {
      codexSandbox: 'read-only',
    })).toBe('codexSandbox');
    expect(firstUnsupportedTargetRuntimeField('codex-cli', {
      permissionMode: 'plan',
    })).toBe('permissionMode');
    expect(firstUnsupportedTargetRuntimeField('grok-build', {
      provider: 'openai',
    })).toBe('provider');
    expect(firstUnsupportedTargetRuntimeField('grok-build', {
      extraAllowWrite: [],
    })).toBe('extraAllowWrite');
    expect(firstUnsupportedTargetRuntimeField('grok-build', {
      grokSandbox: 'strict',
    })).toBeNull();
    expect(firstUnsupportedTargetRuntimeField('codex-cli', {
      grokSandbox: 'strict',
    })).toBe('grokSandbox');
  });

  it('accepts writable roots for both sandbox hosts', () => {
    expect(firstUnsupportedTargetRuntimeField('claude-code', {
      extraAllowWrite: ['/repo-2'],
    })).toBeNull();
    expect(firstUnsupportedTargetRuntimeField('codex-cli', {
      extraAllowWrite: ['/repo-2'],
    })).toBeNull();
  });
});
