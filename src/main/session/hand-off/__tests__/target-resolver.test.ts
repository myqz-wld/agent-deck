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
    codexSandbox: 'read-only', codexApprovalPolicy: 'never', runtimeProvider: 'openai',
    model: 'gpt-source', thinking: 'high',
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
      agentId: 'codex-cli', cwd: '/target', provider: 'openai', model: 'gpt-source',
      modelReasoningEffort: 'high', codexSandbox: 'read-only',
      approvalPolicy: 'never',
      extraAllowWrite: ['/extra'], networkAccessEnabled: true,
      additionalDirectories: ['/tmp'], awaitCanonicalId: true,
      handOff: { mode: 'session', fromCallerSid: 'source', sourceMaxEventId: 42 },
    });
    expect(result.spec).toMatchObject({
      adapter: 'codex-cli', provider: 'openai', model: 'gpt-source', thinking: 'high',
      sandbox: {
        kind: 'codex', mode: 'read-only', extraAllowWriteEffective: true,
        persistedExtraAllowWrite: ['/extra'],
      },
      networkAccessEnabled: true, additionalDirectories: ['/tmp'],
    });
    expect(result.spec.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses target defaults across adapters and passes an explicit Claude Gateway profile', () => {
    const result = resolveHandOffTarget({
      source: source(),
      request: {
        adapter: 'claude-code',
        provider: 'deepseek',
        cwd: '/target',
        model: 'deepseek-v4-pro[1m]',
        thinking: 'max',
      },
      sourceMaxEventId: null,
    });

    expect(result.createOptions).toMatchObject({
      agentId: 'claude-code',
      provider: 'deepseek',
      model: 'deepseek-v4-pro[1m]',
      claudeCodeEffortLevel: 'max', permissionMode: 'bypassPermissions',
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
    });
    expect(result.createOptions).not.toHaveProperty('codexSandbox');
    expect(result.createOptions).not.toHaveProperty('extraAllowWrite');
    expect(result.spec).toMatchObject({
      adapter: 'claude-code',
      provider: 'deepseek',
      model: 'deepseek-v4-pro[1m]',
      thinking: 'max',
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
      approvalPolicy: 'on-request',
    });
    expect(codexResult.spec).toMatchObject({
      sandbox: { kind: 'codex', mode: 'danger-full-access' },
    });
  });

  it('lets an explicit Codex approval policy override same-adapter inheritance', () => {
    const result = resolveHandOffTarget({
      source: source(),
      request: {
        adapter: 'codex-cli',
        cwd: '/target',
        approvalPolicy: 'untrusted',
      },
      sourceMaxEventId: 42,
    });

    expect(result.createOptions).toMatchObject({
      approvalPolicy: 'untrusted',
      codexSandbox: 'read-only',
    });
  });

  it('preserves dontAsk only for recovery and resets a fresh handoff to manual', () => {
    const claudeSource: SessionRecord = {
      ...source(),
      agentId: 'claude-code',
      permissionMode: 'dontAsk',
      codexSandbox: null,
      claudeCodeSandbox: 'workspace-write',
    };
    const result = resolveHandOffTarget({
      source: claudeSource,
      request: { adapter: 'claude-code', cwd: '/target' },
      sourceMaxEventId: 42,
    });

    expect(result.createOptions).toMatchObject({ permissionMode: 'default' });
    expect(result.spec).toMatchObject({ permissionMode: 'default' });
  });

  it('keeps Grok work mode separate and inherits it only for same-adapter handoff', () => {
    const grokSource: SessionRecord = {
      ...source(),
      agentId: 'grok-build',
      permissionMode: null,
      sessionMode: 'ask',
      codexSandbox: null,
      grokSandbox: 'project-locked',
      extraAllowWrite: [],
      networkAccessEnabled: null,
      additionalDirectories: [],
    };

    const inherited = resolveHandOffTarget({
      source: grokSource,
      request: { adapter: 'grok-build', cwd: '/target' },
      sourceMaxEventId: 42,
    });
    expect(inherited.createOptions).toMatchObject({
      agentId: 'grok-build',
      sessionMode: 'ask',
      grokSandbox: 'project-locked',
    });
    expect(inherited.createOptions).not.toHaveProperty('provider');
    expect(inherited.spec).toMatchObject({
      adapter: 'grok-build',
      provider: null,
      sessionMode: 'ask',
      sandbox: { kind: 'grok', profile: 'project-locked' },
    });

    const explicit = resolveHandOffTarget({
      source: source(),
      request: {
        adapter: 'grok-build',
        cwd: '/target',
        sessionMode: 'plan',
        grokSandbox: 'read-only',
      },
      sourceMaxEventId: null,
    });
    expect(explicit.createOptions).toMatchObject({
      agentId: 'grok-build',
      sessionMode: 'plan',
      grokSandbox: 'read-only',
    });
    expect(explicit.spec.sandbox).toEqual({
      kind: 'grok',
      profile: 'read-only',
    });
  });

  it('uses the Grok global request only across adapters and keeps explicit native delegation', () => {
    getSetting.mockImplementation(((key: keyof typeof DEFAULT_SETTINGS) =>
      key === 'grokSandbox' ? 'strict' : DEFAULT_SETTINGS[key]) as typeof settingsStore.get);

    const crossAdapter = resolveHandOffTarget({
      source: source(),
      request: { adapter: 'grok-build', cwd: '/target' },
      sourceMaxEventId: 42,
    });
    expect(crossAdapter.createOptions).toMatchObject({ grokSandbox: 'strict' });
    expect(crossAdapter.spec.sandbox).toEqual({
      kind: 'grok',
      profile: 'strict',
    });

    const native = resolveHandOffTarget({
      source: source(),
      request: { adapter: 'grok-build', cwd: '/target', grokSandbox: null },
      sourceMaxEventId: 42,
    });
    expect(native.createOptions).toHaveProperty('grokSandbox', null);
    expect(native.spec.sandbox).toEqual({ kind: 'grok', profile: null });
  });

  it('accepts explicit Codex writable roots and records them as effective', () => {
    const result = resolveHandOffTarget({
      source: source(),
      request: {
        adapter: 'codex-cli',
        cwd: '/target',
        extraAllowWrite: ['/must-write'],
      },
      sourceMaxEventId: 42,
    });

    expect(result.createOptions).toMatchObject({
      agentId: 'codex-cli',
      extraAllowWrite: ['/must-write'],
    });
    expect(result.spec.sandbox).toMatchObject({
      kind: 'codex',
      extraAllowWriteEffective: true,
      persistedExtraAllowWrite: ['/must-write'],
    });
  });

  it.each([
    ['codex-cli', 'permissionMode', { permissionMode: 'plan' }],
    ['codex-cli', 'claudeCodeSandbox', { claudeCodeSandbox: 'strict' }],
    ['claude-code', 'codexSandbox', { codexSandbox: 'read-only' }],
    ['claude-code', 'networkAccessEnabled', { networkAccessEnabled: true }],
    ['claude-code', 'additionalDirectories', { additionalDirectories: ['/tmp'] }],
    ['claude-code', 'additionalDirectories', { additionalDirectories: [] }],
    ['claude-code', 'sessionMode', { sessionMode: 'ask' }],
    ['codex-cli', 'grokSandbox', { grokSandbox: 'strict' }],
    ['grok-build', 'provider', { provider: 'xai' }],
    ['grok-build', 'extraAllowWrite', { extraAllowWrite: [] }],
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

  it('uses canonical runtime display names in compatibility errors', () => {
    expect(() =>
      resolveHandOffTarget({
        source: source(),
        request: {
          adapter: 'grok-build',
          cwd: '/target',
          provider: 'xai',
        },
        sourceMaxEventId: 42,
      }),
    ).toThrow(
      'provider 与 Grok Build 不兼容；仅 Claude Code 或 Codex CLI 支持',
    );
    expect(() =>
      resolveHandOffTarget({
        source: source(),
        request: {
          adapter: 'claude-code',
          cwd: '/target',
          networkAccessEnabled: true,
        },
        sourceMaxEventId: 42,
      }),
    ).toThrow('networkAccessEnabled 仅与 Codex CLI 兼容');
    expect(() =>
      resolveHandOffTarget({
        source: source(),
        request: {
          adapter: 'grok-build',
          cwd: '/target',
          additionalDirectories: [],
        },
        sourceMaxEventId: 42,
      }),
    ).toThrow('additionalDirectories 仅与 Codex CLI 兼容');
  });
});
