import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SessionRecord } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { HandOffTargetOptionsError, resolveHandOffTarget } from '../target-resolver';

const getSetting = vi.spyOn(settingsStore, 'get');

beforeEach(() => {
  getSetting.mockImplementation(((key: keyof typeof DEFAULT_SETTINGS) =>
    DEFAULT_SETTINGS[key]) as typeof settingsStore.get);
});

function source(): SessionRecord {
  return {
    id: 'source', agentId: 'codex-cli', cwd: '/source', title: 'source', source: 'sdk',
    lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 1,
    endedAt: null, archivedAt: null, permissionMode: null,
    codexSandbox: 'read-only', model: 'gpt-source', thinking: 'high',
    extraAllowWrite: ['/extra'], networkAccessEnabled: true,
    additionalDirectories: ['/tmp'],
  };
}

describe('resolveHandOffTarget', () => {
  it('inherits the complete same-adapter runtime and freezes one fingerprint', () => {
    const result = resolveHandOffTarget({
      source: source(),
      request: { adapter: 'codex-cli', cwd: '/target' },
      sourceMaxEventId: 42,
    });

    expect(result.createOptions).toMatchObject({
      agentId: 'codex-cli', cwd: '/target', model: 'gpt-source',
      modelReasoningEffort: 'high', codexSandbox: 'read-only',
      extraAllowWrite: ['/extra'], networkAccessEnabled: true,
      additionalDirectories: ['/tmp'], awaitCanonicalId: true,
      handOff: { mode: 'session', fromCallerSid: 'source', sourceMaxEventId: 42 },
    });
    expect(result.spec).toMatchObject({
      adapter: 'codex-cli', model: 'gpt-source', thinking: 'high',
      sandbox: {
        kind: 'codex', mode: 'read-only', extraAllowWriteEffective: false,
        persistedExtraAllowWrite: ['/extra'],
      },
      networkAccessEnabled: true, additionalDirectories: ['/tmp'],
    });
    expect(result.spec.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses target defaults across adapters and maps explicit Deepseek aliases', () => {
    const result = resolveHandOffTarget({
      source: source(),
      request: {
        adapter: 'deepseek-claude-code', cwd: '/target', model: 'v4-pro', thinking: 'max',
      },
      sourceMaxEventId: null,
    });

    expect(result.createOptions).toMatchObject({
      agentId: 'deepseek-claude-code', model: 'deepseek-v4-pro[1m]',
      claudeCodeEffortLevel: 'max', permissionMode: 'bypassPermissions',
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
    });
    expect(result.createOptions).not.toHaveProperty('codexSandbox');
    expect(result.createOptions).not.toHaveProperty('extraAllowWrite');
    expect(result.spec).toMatchObject({
      adapter: 'deepseek-claude-code', model: 'deepseek-v4-pro[1m]', thinking: 'max',
      permissionMode: 'bypassPermissions', networkAccessEnabled: null,
      sandbox: { kind: 'claude', mode: DEFAULT_SETTINGS.claudeCodeSandbox },
    });
  });

  it('freezes effective global sandbox defaults and same-adapter default permission mode', () => {
    getSetting.mockImplementation(((key: keyof typeof DEFAULT_SETTINGS) =>
      key === 'claudeCodeSandbox' ? 'strict' : DEFAULT_SETTINGS[key]) as typeof settingsStore.get);
    const claudeSource: SessionRecord = {
      ...source(),
      agentId: 'claude-code',
      codexSandbox: null,
      claudeCodeSandbox: null,
      permissionMode: null,
      extraAllowWrite: [],
      networkAccessEnabled: null,
      additionalDirectories: [],
    };

    const result = resolveHandOffTarget({
      source: claudeSource,
      request: { adapter: 'claude-code', cwd: '/target' },
      sourceMaxEventId: 42,
    });

    expect(result.createOptions).toMatchObject({
      permissionMode: 'default',
      claudeCodeSandbox: 'strict',
    });
    expect(result.spec).toMatchObject({
      permissionMode: 'default',
      sandbox: { kind: 'claude', mode: 'strict' },
    });

    getSetting.mockImplementation(((key: keyof typeof DEFAULT_SETTINGS) =>
      key === 'codexSandbox' ? 'danger-full-access' : DEFAULT_SETTINGS[key]) as typeof settingsStore.get);
    const codexResult = resolveHandOffTarget({
      source: claudeSource,
      request: { adapter: 'codex-cli', cwd: '/target' },
      sourceMaxEventId: 42,
    });
    expect(codexResult.createOptions).toMatchObject({
      codexSandbox: 'danger-full-access',
    });
    expect(codexResult.spec).toMatchObject({
      sandbox: { kind: 'codex', mode: 'danger-full-access' },
    });
  });

  it.each([
    ['codex-cli', 'permissionMode', { permissionMode: 'plan' }],
    ['codex-cli', 'claudeCodeSandbox', { claudeCodeSandbox: 'strict' }],
    ['codex-cli', 'extraAllowWrite', { extraAllowWrite: ['/must-write'] }],
    ['claude-code', 'codexSandbox', { codexSandbox: 'read-only' }],
    ['claude-code', 'networkAccessEnabled', { networkAccessEnabled: true }],
    ['claude-code', 'additionalDirectories', { additionalDirectories: ['/tmp'] }],
  ] as const)(
    'rejects %s-incompatible explicit %s before preparation',
    (adapter, field, incompatible) => {
      expect(() =>
        resolveHandOffTarget({
          source: source(),
          request: { adapter, cwd: '/target', ...incompatible },
          sourceMaxEventId: 42,
        }),
      ).toThrow(HandOffTargetOptionsError);
      try {
        resolveHandOffTarget({
          source: source(),
          request: { adapter, cwd: '/target', ...incompatible },
          sourceMaxEventId: 42,
        });
      } catch (error) {
        expect(error).toMatchObject({ field });
      }
    },
  );
});
