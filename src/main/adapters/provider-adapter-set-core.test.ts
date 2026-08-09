import { describe, expect, it } from 'vitest';
import type { ClaudeCodeAdapterHost } from './claude-code/adapter-core';
import type { CodexCliAdapterHost } from './codex-cli/adapter-core';
import type { GrokBuildAdapterHost } from './grok-build/adapter-core';
import { createProviderAdapterSet } from './provider-adapter-set-core';

function hosts() {
  return {
    claude: {} as ClaudeCodeAdapterHost,
    codex: {} as CodexCliAdapterHost,
    grok: {} as GrokBuildAdapterHost,
  };
}

describe('provider adapter set Core', () => {
  it('constructs the exact provider order from explicit host values', () => {
    const set = createProviderAdapterSet(hosts());

    expect(set.adapters.map((adapter) => adapter.id)).toEqual([
      'claude-code',
      'codex-cli',
      'grok-build',
    ]);
    expect(set.adapters).toEqual([set.claude, set.codex, set.grok]);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.adapters)).toBe(true);
  });

  it('does not reuse provider instances across independently owned runtimes', () => {
    const first = createProviderAdapterSet(hosts());
    const second = createProviderAdapterSet(hosts());

    expect(second.claude).not.toBe(first.claude);
    expect(second.codex).not.toBe(first.codex);
    expect(second.grok).not.toBe(first.grok);
  });
});
