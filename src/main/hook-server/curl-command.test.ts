import { describe, expect, it } from 'vitest';

import { buildHookCurlCommand } from './curl-command';

describe('buildHookCurlCommand', () => {
  it('detects HTTP failures, discards stdout, preserves stderr, and fails open', () => {
    const command = buildHookCurlCommand({
      port: 47_821,
      token: 'token-abc',
      route: '/hook/codex/sessionstart',
      tag: 'agent-deck-hook',
    });

    expect(command).toContain('--fail-with-body');
    expect(command).toContain('--show-error');
    expect(command).toContain('--data-binary @-');
    expect(command).toContain('> /dev/null');
    expect(command).not.toContain('2>');
    expect(command).toContain('|| true # agent-deck-hook');
    expect(command).toContain('Authorization: Bearer token-abc');
    expect(command).toContain('X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}');
  });

  it('retains the Claude Code compatibility guard without forwarding the body', () => {
    const command = buildHookCurlCommand({
      port: 47_821,
      token: 'token-abc',
      route: '/hook/sessionstart',
      tag: 'agent-deck-hook-grok-guard',
      compatibilityGuardEnvironment: 'GROK_HOOK_EVENT',
    });

    expect(command).toContain(
      'if [ -n "${GROK_HOOK_EVENT:-}" ]; then cat > /dev/null; else curl',
    );
    expect(command).toContain('fi || true # agent-deck-hook-grok-guard');
  });

  it('rejects commands without hook authority', () => {
    expect(() =>
      buildHookCurlCommand({
        port: 47_821,
        token: ' ',
        route: '/hook/sessionstart',
        tag: 'agent-deck-hook',
      }),
    ).toThrow('non-empty bearer token');
  });
});
