import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  getUserAssetContent: vi.fn(),
  getBundledAssetPath: vi.fn(() => null as string | null),
  saveBundledAgentRuntimeOverride: vi.fn(),
  resolveCodexModelProvider: vi.fn(),
}));

vi.mock('@main/bundled-assets', () => ({
  getBundledAssets: vi.fn(() => ({ agents: [], skills: [] })),
  getBundledAssetContent: vi.fn(() => ({ ok: false, reason: 'not found' })),
  getBundledAssetPath: mocks.getBundledAssetPath,
  isSafeName: (name: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
}));
vi.mock('@main/user-assets', () => ({
  listUserAssets: vi.fn(() => ({ agents: [], skills: [] })),
  getUserAssetContent: mocks.getUserAssetContent,
  getUserAssetPath: vi.fn(() => null),
}));
vi.mock('@main/bundled-agent-runtime-overrides', () => ({
  saveBundledAgentRuntimeOverride: mocks.saveBundledAgentRuntimeOverride,
  resetBundledAgentRuntimeOverride: vi.fn(),
}));
vi.mock('@main/codex-config/model-providers', () => ({
  listCodexModelProviders: vi.fn(() => []),
  resolveCodexModelProvider: mocks.resolveCodexModelProvider,
}));
vi.mock('@main/adapters/claude-code/gateway-profiles', () => ({
  listClaudeGatewayProfiles: vi.fn(() => []),
}));

import { registerAssetsIpc } from '../assets';

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  expect(registered).toBeTypeOf('function');
  return registered as unknown as (...args: unknown[]) => unknown;
}

describe('Assets Library read-only IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserAssetContent.mockReturnValue({ ok: true, content: 'asset body' });
    mocks.getBundledAssetPath.mockReturnValue(null);
    mocks.resolveCodexModelProvider.mockImplementation((provider: string) => {
      if (provider === 'missing') throw new Error('Codex model_provider 不存在');
      return { id: provider };
    });
    registerAssetsIpc();
  });

  it('accepts native user asset names up to 128 characters', () => {
    const name = `Plugin.Agent_${'x'.repeat(115)}`;
    expect(name).toHaveLength(128);

    expect(handler(IpcInvoke.AssetsGetContent)(
      {},
      'agent',
      name,
      'user',
      'claude-code',
      '/plugins/demo/agents/Plugin.Agent.md',
    )).toEqual({ ok: true, content: 'asset body' });
    expect(mocks.getUserAssetContent).toHaveBeenCalledWith(
      'agent',
      name,
      'claude-code',
      '/plugins/demo/agents/Plugin.Agent.md',
    );
  });

  it('registers no user Agent or Skill mutation channels', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
    expect(channels).not.toContain('assets:save-user');
    expect(channels).not.toContain('assets:delete-user');
  });

  it('rejects a nonexistent bundled Codex provider before saving prior state', () => {
    mocks.getBundledAssetPath.mockReturnValue('/bundled/reviewer-codex.toml');

    expect(() => handler(IpcInvoke.AssetsSaveBundledAgentRuntime)(
      {},
      'codex-cli',
      'reviewer-codex',
      { provider: 'missing', model: 'gpt-5.6' },
    )).toThrow(/model_provider 不存在/);
    expect(mocks.saveBundledAgentRuntimeOverride).not.toHaveBeenCalled();
  });
});
