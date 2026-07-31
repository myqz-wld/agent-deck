import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../window', () => ({ getFloatingWindow: () => ({ window: null }) }));
vi.mock('../adapters/registry', () => ({ adapterRegistry: { get: vi.fn() } }));
vi.mock('../session/manager', () => ({ sessionManager: {} }));
vi.mock('../event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ error: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {},
  TeamInvariantError: class TeamInvariantError extends Error {},
}));

import { parseCliInvocation } from '../cli';

describe('agent-deck new model options', () => {
  it('owns the Claude Code default in TypeScript and preserves an explicit override', () => {
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'claude-code',
    ])).toMatchObject({
      kind: 'new-session',
      agent: 'claude-code',
      permissionMode: 'bypassPermissions',
    });
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'claude-code',
      '--permission-mode',
      'plan',
    ])).toMatchObject({
      permissionMode: 'plan',
    });
  });

  it('owns the Codex approval default and preserves explicit approval and sandbox overrides', () => {
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'codex-cli',
    ])).toMatchObject({
      kind: 'new-session',
      agent: 'codex-cli',
      approvalPolicy: 'on-request',
    });
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'codex-cli',
      '--approval-policy',
      'never',
      '--codex-sandbox',
      'read-only',
    ])).toMatchObject({
      approvalPolicy: 'never',
      codexSandbox: 'read-only',
    });
  });

  it('delegates the Grok Build default and preserves its explicit sandbox override', () => {
    const delegated = parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok-build',
    ]);
    expect(delegated).toMatchObject({
      kind: 'new-session',
      agent: 'grok-build',
    });
    expect(delegated).toMatchObject({
      permissionMode: undefined,
      approvalPolicy: undefined,
    });
    expect(delegated).not.toHaveProperty('grokSandbox');
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok-build',
      '--grok-sandbox',
      'read-only',
    ])).toMatchObject({
      grokSandbox: 'read-only',
    });
  });

  it('parses a Codex model_provider, free-form model, and thinking for the lead session', () => {
    expect(
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'codex-cli',
        '--provider',
        'fable',
        '--model',
        'provider/custom-model',
        '--thinking',
        'ultra',
      ]),
    ).toMatchObject({
      kind: 'new-session',
      agent: 'codex-cli',
      provider: 'fable',
      model: 'provider/custom-model',
      thinking: 'ultra',
    });
  });

  it('parses a Claude Gateway with the adapter-native flag', () => {
    expect(
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'claude-code',
        '--gateway',
        'deepseek',
      ]),
    ).toMatchObject({
      kind: 'new-session',
      agent: 'claude-code',
      gateway: 'deepseek',
    });
  });

  it('rejects the retired Codex profile flag with a migration hint', () => {
    expect(() =>
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'codex-cli',
        '--profile',
        'work',
      ]),
    ).toThrow(/--profile 已停用.*--provider <model_provider>.*config\.toml/);
  });

  it('rejects the Codex provider flag for non-Codex adapters', () => {
    expect(() =>
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'claude-code',
        '--provider',
        'openrouter',
      ]),
    ).toThrow('--provider 与 adapter "claude-code" 不兼容');
  });

  it('rejects a provider profile used as an adapter name', () => {
    expect(() =>
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'deepseek',
      ]),
    ).toThrow('--adapter 取值无效');
  });

  it('rejects a value-less thinking flag instead of silently using a default', () => {
    expect(() =>
      parseCliInvocation(['/Applications/Agent Deck', 'new', '--thinking']),
    ).toThrow('--thinking 缺少取值');
  });

  it.each(['auto', 'bypassPermissions'] as const)(
    'accepts the current Claude permission mode %s',
    (permissionMode) => {
      expect(
        parseCliInvocation([
          '/Applications/Agent Deck',
          'new',
          '--adapter',
          'claude-code',
          '--permission-mode',
          permissionMode,
        ]),
      ).toMatchObject({
        kind: 'new-session',
        agent: 'claude-code',
        permissionMode,
      });
    },
  );

  it('rejects an unsupported Claude permission mode', () => {
    expect(() =>
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'claude-code',
        '--permission-mode',
        'dontAsk',
      ]),
    ).toThrow('--permission-mode 取值无效');
  });

  it('rejects Claude permission modes for Codex and Grok instead of ignoring them', () => {
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'codex-cli',
      '--permission-mode',
      'bypassPermissions',
    ])).toThrow('--permission-mode 与 adapter "codex-cli" 不兼容');
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok-build',
      '--permission-mode',
      'plan',
    ])).toThrow('--permission-mode 与 adapter "grok-build" 不兼容');
  });

  it('rejects Codex sandbox flags for non-Codex adapters', () => {
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'claude-code',
      '--codex-sandbox',
      'read-only',
    ])).toThrow('--codex-sandbox 与 adapter "claude-code" 不兼容');
  });

  it('rejects approval flags for non-Codex adapters', () => {
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'claude-code',
      '--approval-policy',
      'never',
    ])).toThrow('--approval-policy 与 adapter "claude-code" 不兼容');
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'codex-cli',
      '--approval-policy',
      'automatic',
    ])).toThrow('--approval-policy 取值无效');
  });

  it('parses built-in and custom Grok sandbox profiles only for Grok', () => {
    expect(parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok-build',
      '--grok-sandbox',
      ' project-locked ',
    ])).toMatchObject({
      kind: 'new-session',
      agent: 'grok-build',
      grokSandbox: 'project-locked',
    });
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'codex-cli',
      '--grok-sandbox',
      'strict',
    ])).toThrow('--grok-sandbox 与 adapter "codex-cli" 不兼容');
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok-build',
      '--grok-sandbox',
      'strict\nworkspace',
    ])).toThrow('--grok-sandbox 取值无效');
  });
});
