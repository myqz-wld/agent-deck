import { describe, expect, it } from 'vitest';
import {
  firstUnsupportedTargetRuntimeField,
  targetRuntimeFieldsForAdapter,
  unsupportedTargetRuntimeFieldMessage,
} from '../runtime-control-contracts';

describe('adapter target runtime control contracts', () => {
  it('keeps Claude, Codex, and Grok provider-native controls separate', () => {
    expect(targetRuntimeFieldsForAdapter('claude-code')).toEqual([
      'gateway',
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
    expect(firstUnsupportedTargetRuntimeField('codex-cli', {
      provider: 'openrouter',
    })).toBeNull();
    expect(firstUnsupportedTargetRuntimeField('codex-cli', {
      profile: 'work',
    })).toBe('profile');
    expect(firstUnsupportedTargetRuntimeField('grok-build', {
      gateway: 'openai',
    })).toBe('gateway');
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
      unsupportedTargetRuntimeFieldMessage('grok-build', 'gateway'),
    ).toBe(
      'gateway 与 Grok Build 不兼容；仅 Claude Code 支持',
    );
    expect(
      unsupportedTargetRuntimeFieldMessage('claude-code', 'profile'),
    ).toBe(
      'profile 已停用；内置 Codex app-server 不支持 --profile。Codex CLI 请改用 provider=<model_provider>，或省略该字段以使用 $CODEX_HOME/config.toml',
    );
    expect(
      unsupportedTargetRuntimeFieldMessage('codex-cli', 'grokSandbox'),
    ).toBe('grokSandbox 与 Codex CLI 不兼容；仅 Grok Build 支持');
    expect(
      unsupportedTargetRuntimeFieldMessage('codex-cli', 'permissionMode'),
    ).toBe('permissionMode 与 Codex CLI 不兼容；仅 Claude Code 支持');
  });
});
