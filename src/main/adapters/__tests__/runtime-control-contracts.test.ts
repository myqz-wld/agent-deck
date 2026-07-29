import { describe, expect, it } from 'vitest';
import {
  firstUnsupportedTargetRuntimeField,
  targetRuntimeFieldsForAdapter,
  unsupportedTargetRuntimeFieldMessage,
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
      'approvalPolicy',
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

  it('uses canonical adapter display names in incompatibility messages', () => {
    expect(
      unsupportedTargetRuntimeFieldMessage('grok-build', 'provider'),
    ).toBe(
      'provider 与 Grok Build 不兼容；仅 Claude Code 或 Codex CLI 支持',
    );
    expect(
      unsupportedTargetRuntimeFieldMessage('codex-cli', 'grokSandbox'),
    ).toBe('grokSandbox 与 Codex CLI 不兼容；仅 Grok Build 支持');
    expect(
      unsupportedTargetRuntimeFieldMessage('codex-cli', 'permissionMode'),
    ).toBe('permissionMode 与 Codex CLI 不兼容；仅 Claude Code 支持');
  });
});
