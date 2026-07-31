import { describe, expect, it } from 'vitest';

import { buildHookCurlCommand } from './curl-command';

describe('buildHookCurlCommand', () => {
  it('uses an absolute private relay config without embedding hook authority', () => {
    const command = buildHookCurlCommand({
      relayConfigPath: "/tmp/Agent Deck's relay/sessionstart.curlrc",
      tag: 'agent-deck-hook-v2-codex-cli-sessionstart',
    });

    expect(command).toContain(
      `--config '/tmp/Agent Deck'\"'\"'s relay/sessionstart.curlrc'`,
    );
    expect(command).toContain('--data-binary @-');
    expect(command).toContain('> /dev/null');
    expect(command).not.toContain('2>');
    expect(command).toContain(
      '|| true # agent-deck-hook-v2-codex-cli-sessionstart',
    );
    expect(command).not.toContain('Authorization');
    expect(command).not.toContain('Bearer');
    expect(command).toContain('X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}');
  });

  it('retains the Claude Code compatibility guard without forwarding the body', () => {
    const command = buildHookCurlCommand({
      relayConfigPath: '/tmp/agent-deck/hook-relay/sessionstart.curlrc',
      tag: 'agent-deck-hook-v2-claude-code-sessionstart',
      compatibilityGuardEnvironment: 'GROK_HOOK_EVENT',
    });

    expect(command).toContain(
      'if [ -n "${GROK_HOOK_EVENT:-}" ]; then cat > /dev/null; else curl',
    );
    expect(command).toContain(
      'fi || true # agent-deck-hook-v2-claude-code-sessionstart',
    );
  });

  it('rejects unsafe relay paths and ownership metadata', () => {
    expect(() =>
      buildHookCurlCommand({
        relayConfigPath: 'relative/sessionstart.curlrc',
        tag: 'agent-deck-hook',
      }),
    ).toThrow('absolute private relay config path');
    expect(() =>
      buildHookCurlCommand({
        relayConfigPath: '/tmp/sessionstart.curlrc',
        tag: 'agent-deck-hook # injected',
      }),
    ).toThrow('static ownership tag');
  });
});
