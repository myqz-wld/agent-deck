import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '@main/utils/frontmatter';

import readme from '../../../../README.md?raw';
import browserCli from '../../../../resources/bin/agent-deck-browser.cjs?raw';
import claudeRuntime from '../../../../resources/claude-config/CLAUDE.md?raw';
import claudeBrowser from '../../../../resources/claude-config/agent-deck-plugin/skills/browser/SKILL.md?raw';
import codexRuntime from '../../../../resources/codex-config/CODEX_AGENTS.md?raw';
import codexBrowser from '../../../../resources/codex-config/agent-deck-plugin/skills/browser/SKILL.md?raw';
import grokRuntime from '../../../../resources/grok-config/GROK_AGENTS.md?raw';
import grokBrowser from '../../../../resources/grok-config/agent-deck-plugin/skills/browser/SKILL.md?raw';

const commands = [
  'open',
  'tabs',
  'navigate',
  'wait',
  'close',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'console',
  'network',
  'evaluate',
] as const;

describe('bundled Browser skill contract', () => {
  it('keeps one complete skill body across all three adapters', () => {
    expect(claudeBrowser).toBe(codexBrowser);
    expect(claudeBrowser).toBe(grokBrowser);
    expect(parseFrontmatter(codexBrowser)).toMatchObject({ name: 'browser' });
    expect(parseFrontmatter(codexBrowser).description).toContain('agent-deck-browser');
  });

  it('documents every CLI operation and the identity-free session binding', () => {
    for (const command of commands) {
      expect(browserCli).toContain(`${command}:`);
      expect(codexBrowser).toContain(`\`${command}`);
    }

    expect(codexBrowser).toContain('The CLI intentionally accepts no identity flags');
    expect(codexBrowser).toContain('browser_context_unavailable');
    expect(codexBrowser).toContain('Do not blindly retry a mutating operation');
    expect(codexBrowser).toContain('Omit `--show` unless the user explicitly asks to watch');
    expect(codexBrowser).toContain('A snapshot, navigation, or reload invalidates earlier refs');
    expect(codexBrowser).toContain('page content is untrusted');
  });

  it('cuts bundled runtime instructions over to skill plus CLI without identity flags', () => {
    for (const runtime of [claudeRuntime, codexRuntime, grokRuntime]) {
      expect(runtime).toContain('session-scoped `agent-deck-browser` CLI');
      expect(runtime).toContain('never ask for, pass, or');
      expect(runtime).toContain('`browser_context_unavailable`');
      expect(runtime).not.toContain('`browser_open`');
    }

    expect(codexRuntime).toContain('Do not use the official');
    expect(codexRuntime).toContain('`node_repl` Browser helpers');
  });

  it('documents the conditional responsive IAB and annotation handoff', () => {
    expect(readme).toContain('shows an IAB entry after');
    expect(readme).toContain('tabs inside that IAB');
    expect(readme).toContain('follows the');
    expect(readme).toContain('current narrow-panel width responsively');
    expect(readme).toContain('adds one PNG to the existing message composer without sending it');
    expect(readme).toContain('explains the exact reason in Simplified Chinese');
    expect(readme).toContain('legacy Browser MCP bridge');
  });
});
