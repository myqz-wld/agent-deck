import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostNodeAssetContent,
  parseRemoteHostNodeAssetConvention,
} from './input-validation-node-assets';

describe('Remote node asset input validation', () => {
  it('accepts exact Worker asset identities', () => {
    expect(parseRemoteHostNodeAssetContent({
      profileId: 'remote-a', adapterId: 'claude-code', kind: 'agent',
      source: 'bundled', name: 'reviewer-claude',
      qualifiedName: 'agent-deck:claude-code:reviewer-claude',
      location: 'Worker packaged resources/claude-config/agents/reviewer-claude.md',
    })).toMatchObject({ name: 'reviewer-claude' });
    expect(parseRemoteHostNodeAssetConvention({
      profileId: 'remote-a', adapterId: 'codex-cli',
    }).adapterId).toBe('codex-cli');
  });

  it('rejects path injection and extra fields', () => {
    expect(() => parseRemoteHostNodeAssetContent({
      profileId: 'remote-a', adapterId: 'claude-code', kind: 'agent',
      source: 'bundled', name: '../secret', qualifiedName: '../secret',
      location: 'Worker packaged resources/secret',
    })).toThrow();
    expect(() => parseRemoteHostNodeAssetConvention({
      profileId: 'remote-a', adapterId: 'codex-cli', localFallback: true,
    })).toThrow();
  });
});
