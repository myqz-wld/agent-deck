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
  it('parses a free-form model and thinking flag for the lead session', () => {
    expect(
      parseCliInvocation([
        '/Applications/Agent Deck',
        'new',
        '--adapter',
        'codex',
        '--model',
        'provider/custom-model',
        '--thinking',
        'ultra',
      ]),
    ).toMatchObject({
      kind: 'new-session',
      agent: 'codex-cli',
      model: 'provider/custom-model',
      thinking: 'ultra',
    });
  });

  it('rejects a value-less thinking flag instead of silently using a default', () => {
    expect(() =>
      parseCliInvocation(['/Applications/Agent Deck', 'new', '--thinking']),
    ).toThrow('--thinking 缺少取值');
  });
});
