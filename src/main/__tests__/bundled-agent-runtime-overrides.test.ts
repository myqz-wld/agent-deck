import { beforeEach, describe, expect, it } from 'vitest';
import { settingsStore } from '@main/store/settings-store';
import {
  getBundledAgentRuntimeOverride,
  resetBundledAgentRuntimeOverride,
  saveBundledAgentRuntimeOverride,
} from '@main/bundled-agent-runtime-overrides';

describe('bundled Agent runtime override persistence', () => {
  beforeEach(() => {
    settingsStore.set('bundledAgentRuntimeOverrides', {});
  });

  it('stores independent adapter:name deltas and removes an empty update', () => {
    saveBundledAgentRuntimeOverride('codex-cli', 'reviewer-codex', {
      model: 'qw-pro-5',
      provider: 'fable',
    });
    saveBundledAgentRuntimeOverride('grok-build', 'reviewer-grok', {
      model: 'grok-4.5',
      thinking: 'high',
    });

    expect(
      getBundledAgentRuntimeOverride('codex-cli', 'reviewer-codex'),
    ).toEqual({ model: 'qw-pro-5', provider: 'fable' });
    resetBundledAgentRuntimeOverride('codex-cli', 'reviewer-codex');
    expect(
      getBundledAgentRuntimeOverride('codex-cli', 'reviewer-codex'),
    ).toEqual({});
    expect(
      getBundledAgentRuntimeOverride('grok-build', 'reviewer-grok'),
    ).toEqual({ model: 'grok-4.5', thinking: 'high' });
  });

  it('fails closed when the persisted map is malformed', () => {
    settingsStore.set(
      'bundledAgentRuntimeOverrides',
      null as unknown as Record<string, never>,
    );
    expect(
      getBundledAgentRuntimeOverride('claude-code', 'reviewer-claude'),
    ).toEqual({});
  });
});
