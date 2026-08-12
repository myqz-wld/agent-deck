import { describe, expect, it, vi } from 'vitest';

import { RemoteHostNodeAssetController } from './service-node-assets';

describe('RemoteHostNodeAssetController', () => {
  it('routes every asset read only through the selected Remote Core', async () => {
    const client = { request: vi.fn(async (method: string) => {
      if (method === 'node.assets.catalog.list') return {
        assets: [],
        assetsTruncated: false,
        injection: {
          injectAgentDeckClaudeSkills: true, injectAgentDeckClaudeAgents: true,
          injectAgentDeckClaudeMd: true, injectAgentDeckCodexSkills: true,
          injectAgentDeckCodexAgents: true, injectAgentDeckCodexAgentsMd: true,
          injectAgentDeckGrokSkills: true, injectAgentDeckGrokAgents: true,
          injectAgentDeckGrokAgentsMd: true,
        },
        readOnlyReason: 'Worker configuration is immutable.', revision: 1,
      };
      if (method === 'node.assets.content') return { content: '# remote', revision: 1 };
      return { adapterId: 'codex-cli', content: '# worker', isCustom: false, revision: 1 };
    }) };
    const request = vi.fn(async (_profileId, _operation, run) => run({ client }));
    const controller = new RemoteHostNodeAssetController(request);
    await controller.list({ profileId: 'remote-a' });
    await controller.content({
      profileId: 'remote-a', adapterId: 'codex-cli', kind: 'skill',
      source: 'bundled', name: 'deep-review',
      qualifiedName: 'agent-deck:codex-cli:deep-review',
      location: 'Worker packaged resources/codex-config/skills/deep-review/SKILL.md',
    });
    await controller.convention({ profileId: 'remote-a', adapterId: 'codex-cli' });
    expect(client.request.mock.calls.map((call) => call[0])).toEqual([
      'node.assets.catalog.list', 'node.assets.content', 'node.assets.convention',
    ]);
    expect(client.request).toHaveBeenNthCalledWith(2, 'node.assets.content', {
      adapterId: 'codex-cli',
      kind: 'skill',
      source: 'bundled',
      name: 'deep-review',
      qualifiedName: 'agent-deck:codex-cli:deep-review',
      location: 'Worker packaged resources/codex-config/skills/deep-review/SKILL.md',
    }, expect.any(Object));
  });
});
