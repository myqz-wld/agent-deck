import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBundledAssetContent } = vi.hoisted(() => ({
  getBundledAssetContent: vi.fn(),
}));
vi.mock('@main/bundled-assets', () => ({ getBundledAssetContent }));

import { resolveSpawnAgent } from '../tools/handlers/spawn-agent-resolver';

describe('Grok spawn agent resolution', () => {
  beforeEach(() => getBundledAssetContent.mockReset());

  it('passes a validated bundled Grok agent name through to ACP', () => {
    getBundledAssetContent.mockReturnValue({ ok: true, content: 'agent body' });
    expect(resolveSpawnAgent('reviewer-grok', 'grok-build', '/repo')).toEqual({
      ok: true,
      grokAgentName: 'reviewer-grok',
    });
  });

  it('describes the narrower Grok lookup boundary on failure', () => {
    getBundledAssetContent.mockReturnValue({ ok: false, reason: 'not found' });
    const result = resolveSpawnAgent('missing', 'grok-build', '/repo');
    expect(result).toMatchObject({
      ok: false,
      hint: expect.stringContaining('bundled Agent Deck plugin agents only'),
    });
  });
});
