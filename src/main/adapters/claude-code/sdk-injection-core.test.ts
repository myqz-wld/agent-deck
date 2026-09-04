import { describe, expect, it, vi } from 'vitest';
import {
  formatClaudeSystemPromptAppend,
  selectClaudeSessionPlugins,
} from './sdk-injection-core';

describe('Claude SDK injection Core', () => {
  it('selects the mirror first, deduplicates it, and preserves native plugins', () => {
    const installMirror = vi.fn(() => '/mirror');

    expect(
      selectClaudeSessionPlugins({
        includeAgents: true,
        includeSkills: false,
        installMirror,
        selectedPluginDir: '/native',
      }),
    ).toEqual([
      { type: 'local', path: '/mirror' },
      { type: 'local', path: '/native' },
    ]);
    expect(installMirror).toHaveBeenCalledWith({
      includeAgents: true,
      includeSkills: false,
    });
    expect(
      selectClaudeSessionPlugins({
        includeAgents: true,
        includeSkills: true,
        installMirror,
        selectedPluginDir: '/mirror',
      }),
    ).toEqual([{ type: 'local', path: '/mirror' }]);
  });

  it('skips mirror work when disabled and formats only non-empty prompt content', () => {
    const installMirror = vi.fn(() => '/mirror');
    expect(
      selectClaudeSessionPlugins({
        includeAgents: false,
        includeSkills: false,
        installMirror,
        selectedPluginDir: '/native',
      }),
    ).toEqual([{ type: 'local', path: '/native' }]);
    expect(installMirror).not.toHaveBeenCalled();
    expect(formatClaudeSystemPromptAppend('')).toBe('');
    expect(formatClaudeSystemPromptAppend('rules')).toBe(
      '\n\n--- Agent Deck application conventions ---\n\nrules',
    );
  });
});
