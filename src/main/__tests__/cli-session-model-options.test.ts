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
  it('parses provider, free-form model, and thinking for the lead session', () => {
    expect(
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'codex',
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

  it('does not alias the retired Deepseek adapter name', () => {
    expect(
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'deepseek',
      ]),
    ).toMatchObject({
      kind: 'new-session',
      agent: 'deepseek',
    });
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
          'claude',
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

  it('rejects the retired dontAsk Claude permission mode', () => {
    expect(() =>
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'claude',
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
      'codex',
      '--permission-mode',
      'bypassPermissions',
    ])).toThrow('--permission-mode 与 adapter "codex-cli" 不兼容');
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'grok',
      '--permission-mode',
      'plan',
    ])).toThrow('--permission-mode 与 adapter "grok-build" 不兼容');
  });

  it('rejects Codex sandbox flags for non-Codex adapters', () => {
    expect(() => parseCliInvocation([
      '/Applications/Agent Deck',
      'new',
      '--adapter',
      'claude',
      '--codex-sandbox',
      'read-only',
    ])).toThrow('--codex-sandbox 与 adapter "claude-code" 不兼容');
  });
});
