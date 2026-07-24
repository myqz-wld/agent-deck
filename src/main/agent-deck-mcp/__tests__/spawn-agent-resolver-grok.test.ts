import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBundledAssetContent } = vi.hoisted(() => ({
  getBundledAssetContent: vi.fn(),
}));
const { getBundledAgentRuntimeOverride } = vi.hoisted(() => ({
  getBundledAgentRuntimeOverride: vi.fn(),
}));
vi.mock('@main/bundled-assets', () => ({ getBundledAssetContent }));
vi.mock('@main/bundled-agent-runtime-overrides', () => ({
  getBundledAgentRuntimeOverride,
}));

import { resolveSpawnAgent } from '../tools/handlers/spawn-agent-resolver';

describe('Grok spawn agent resolution', () => {
  beforeEach(() => {
    getBundledAssetContent.mockReset();
    getBundledAgentRuntimeOverride.mockReset().mockReturnValue({});
  });

  it('passes a validated bundled Grok agent name through to ACP', () => {
    getBundledAssetContent.mockReturnValue({
      ok: true,
      content: '---\nmodel: grok-4.5\neffort: high\n---\nagent body',
    });
    expect(resolveSpawnAgent('reviewer-grok', 'grok-build', '/repo')).toEqual({
      ok: true,
      grokAgentName: 'reviewer-grok',
      model: 'grok-4.5',
      grokReasoningEffort: 'high',
    });
  });

  it('applies the app-owned Grok runtime delta over bundled defaults', () => {
    getBundledAssetContent.mockReturnValue({
      ok: true,
      content: '---\nmodel: grok-4.5\neffort: high\n---\nagent body',
    });
    getBundledAgentRuntimeOverride.mockReturnValue({
      model: 'custom-grok',
      thinking: 'medium',
    });

    expect(resolveSpawnAgent('reviewer-grok', 'grok-build', '/repo')).toMatchObject({
      ok: true,
      model: 'custom-grok',
      grokReasoningEffort: 'medium',
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
