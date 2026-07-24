import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBundledAssetContent } = vi.hoisted(() => ({
  getBundledAssetContent: vi.fn(),
}));
const { getBundledAgentRuntimeOverride } = vi.hoisted(() => ({
  getBundledAgentRuntimeOverride: vi.fn(),
}));
const { resolveGrokUserAgentContent } = vi.hoisted(() => ({
  resolveGrokUserAgentContent: vi.fn(),
}));
const { getSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(() => true),
}));
vi.mock('@main/bundled-assets', () => ({ getBundledAssetContent }));
vi.mock('@main/bundled-agent-runtime-overrides', () => ({
  getBundledAgentRuntimeOverride,
}));
vi.mock('@main/adapters/grok-build/custom-assets', () => ({ resolveGrokUserAgentContent }));
vi.mock('@main/store/settings-store', () => ({ settingsStore: { get: getSetting } }));

import { resolveSpawnAgent } from '../tools/handlers/spawn-agent-resolver';

describe('Grok spawn agent resolution', () => {
  beforeEach(() => {
    getBundledAssetContent.mockReset();
    getBundledAgentRuntimeOverride.mockReset().mockReturnValue({});
    resolveGrokUserAgentContent.mockReset().mockReturnValue({ ok: false, reason: 'not found' });
    getSetting.mockReset().mockReturnValue(true);
  });

  it('passes a validated bundled Grok agent name through to ACP', () => {
    getBundledAssetContent.mockReturnValue({
      ok: true,
      content: '---\nmodel: grok-4.5\neffort: high\n---\nagent body',
    });
    expect(resolveSpawnAgent('reviewer-grok', 'grok-build', '/repo')).toEqual({
      ok: true,
      grokAgentName: 'reviewer-grok',
      grokAgentSource: 'bundled',
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

  it.each([
    ['project', 'project-agent'],
    ['user', 'user-agent'],
    ['plugin', 'plugin-agent'],
  ] as const)('resolves a native %s Grok agent without bundled overrides', (source, name) => {
    getBundledAssetContent.mockReturnValue({ ok: false, reason: 'bundled miss' });
    resolveGrokUserAgentContent.mockReturnValue({
      ok: true,
      agent: {
        name,
        source,
        sourcePath: `/tmp/${name}.md`,
        ...(source === 'plugin' ? { pluginDir: '/tmp/plugin' } : {}),
        content: `---\nmodel: native-model\neffort: xhigh\n---\n${name}`,
        frontmatter: { model: 'native-model', effort: 'xhigh' },
      },
    });

    expect(resolveSpawnAgent(name, 'grok-build', '/repo')).toMatchObject({
      ok: true,
      grokAgentName: name,
      grokAgentSource: source,
      ...(source === 'plugin' ? { grokPluginDir: '/tmp/plugin' } : {}),
      model: 'native-model',
      grokReasoningEffort: 'xhigh',
    });
    expect(getBundledAgentRuntimeOverride).not.toHaveBeenCalled();
    expect(resolveGrokUserAgentContent).toHaveBeenCalledTimes(1);
  });

  it('allows native custom agents when bundled Grok agents are disabled', () => {
    getSetting.mockReturnValue(false);
    getBundledAssetContent.mockImplementation(() => {
      throw new Error('bundled assets must not be read when disabled');
    });
    resolveGrokUserAgentContent.mockReturnValue({
      ok: true,
      agent: {
        name: 'custom-agent',
        source: 'user',
        sourcePath: '/tmp/custom-agent.md',
        content: '---\n---\ncustom',
        frontmatter: {},
      },
    });

    expect(resolveSpawnAgent('custom-agent', 'grok-build', '/repo')).toMatchObject({
      ok: true,
      grokAgentSource: 'user',
    });
  });

  it('describes the narrower Grok lookup boundary on failure', () => {
    getBundledAssetContent.mockReturnValue({ ok: false, reason: 'not found' });
    const result = resolveSpawnAgent('missing', 'grok-build', '/repo');
    expect(result).toMatchObject({
      ok: false,
      hint: expect.stringContaining('bundled/project/user/plugin'),
    });
  });
});
