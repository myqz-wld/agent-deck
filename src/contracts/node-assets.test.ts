import { describe, expect, it } from 'vitest';

import {
  parseNodeAssetContentParams,
  parseNodeAssetListResult,
} from './node-assets';

function catalog(source: unknown): Record<string, unknown> {
  return {
    assets: [{
      adapterId: 'codex-cli', kind: 'skill', source, name: 'deep-review',
      qualifiedName: 'agent-deck:codex-cli:deep-review', description: 'review',
      location: 'Worker packaged resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md',
      tools: null, model: null, thinking: null, provider: null, origin: null,
      pluginName: null, runtimeName: null, runtimeDefaults: null, runtimeOverride: null,
    }],
    assetsTruncated: false,
    injection: {
      injectAgentDeckClaudeSkills: true, injectAgentDeckClaudeAgents: true,
      injectAgentDeckClaudeMd: true, injectAgentDeckCodexSkills: true,
      injectAgentDeckCodexAgents: true, injectAgentDeckCodexAgentsMd: true,
      injectAgentDeckGrokSkills: true, injectAgentDeckGrokAgents: true,
      injectAgentDeckGrokAgentsMd: true,
    },
    readOnlyReason: 'Worker startup configuration is immutable.',
    revision: 4,
  };
}

describe('node asset contract', () => {
  it('accepts one bounded Worker-owned asset snapshot', () => {
    expect(parseNodeAssetListResult(catalog('bundled')).assets[0]?.name).toBe('deep-review');
  });

  it('rejects user assets from catalogs and content requests', () => {
    expect(() => parseNodeAssetListResult(catalog('user'))).toThrow();
    expect(() => parseNodeAssetContentParams({
      adapterId: 'codex-cli', kind: 'skill', source: 'user', name: 'personal-skill',
      qualifiedName: 'personal-skill', location: 'Personal configuration/skills/personal-skill',
    })).toThrow();
  });

  it('rejects path-like names and unknown fields', () => {
    expect(() => parseNodeAssetContentParams({
      adapterId: 'codex-cli', kind: 'skill', source: 'bundled', name: '../secret',
      qualifiedName: '../secret', location: 'Worker packaged resources/secret',
    })).toThrow();
    expect(() => parseNodeAssetContentParams({
      adapterId: 'codex-cli', kind: 'skill', source: 'bundled', name: 'safe',
      qualifiedName: 'safe', location: 'Worker packaged resources/safe', path: '/tmp',
    })).toThrow();
  });
});
