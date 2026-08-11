// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AssetsLibraryDialog } from './AssetsLibraryDialog';

const INJECTION = {
  injectAgentDeckClaudeSkills: true,
  injectAgentDeckClaudeAgents: true,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckCodexSkills: true,
  injectAgentDeckCodexAgents: true,
  injectAgentDeckCodexAgentsMd: true,
  injectAgentDeckGrokSkills: true,
  injectAgentDeckGrokAgents: true,
  injectAgentDeckGrokAgentsMd: true,
} as const;

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

function installApi() {
  const local = {
    listBundledAssets: vi.fn(),
    listUserAssets: vi.fn(),
    getSettings: vi.fn(),
    getAssetContent: vi.fn(),
    setSettings: vi.fn(),
    revealAssetInFolder: vi.fn(),
    confirmDialog: vi.fn(),
  };
  const remote = {
    listRemoteHostNodeAssets: vi.fn().mockResolvedValue({
      assets: [{
        adapterId: 'claude-code',
        kind: 'skill',
        source: 'bundled',
        name: 'deep-review',
        qualifiedName: 'agent-deck:claude-code:deep-review',
        description: 'Worker review skill',
        location: 'Worker packaged resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md',
        tools: null,
        model: null,
        thinking: null,
        provider: null,
        origin: null,
        pluginName: null,
        runtimeName: null,
      }],
      assetsTruncated: false,
      injection: INJECTION,
      readOnlyReason: 'Worker 启动配置只读。',
      revision: 7,
    }),
    getRemoteHostNodeAssetContent: vi.fn().mockResolvedValue({
      content: '# Worker deep review',
      revision: 7,
    }),
    getRemoteHostNodeAssetConvention: vi.fn().mockResolvedValue({
      adapterId: 'claude-code',
      content: '# Worker CLAUDE.md',
      isCustom: false,
      revision: 7,
    }),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...local, ...remote },
  });
  return { local, remote };
}

describe('AssetsLibraryDialog source authority', () => {
  it('reads list, content and conventions only from the selected Remote Worker', async () => {
    const { local, remote } = installApi();
    render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);

    expect(await screen.findByText('(Remote · aws-relay-on-mac)')).toBeTruthy();
    expect(await screen.findByText('agent-deck:claude-code:deep-review')).toBeTruthy();
    expect(screen.getByText('Worker Provider Home/.claude/skills/')).toBeTruthy();
    expect(screen.getByText('Worker 启动配置只读。')).toBeTruthy();
    for (const toggle of screen.getAllByRole('checkbox')) {
      expect((toggle as HTMLInputElement).disabled).toBe(true);
    }

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(await screen.findByText('# Worker deep review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '显示文件' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    fireEvent.click(screen.getByRole('button', { name: '应用约定' }));
    expect(await screen.findByText('# Worker CLAUDE.md')).toBeTruthy();

    expect(remote.listRemoteHostNodeAssets).toHaveBeenCalledWith({ profileId: 'remote-a' });
    expect(remote.getRemoteHostNodeAssetContent).toHaveBeenCalledWith({
      profileId: 'remote-a',
      adapterId: 'claude-code',
      kind: 'skill',
      source: 'bundled',
      name: 'deep-review',
      qualifiedName: 'agent-deck:claude-code:deep-review',
      location: 'Worker packaged resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md',
    });
    expect(remote.getRemoteHostNodeAssetConvention).toHaveBeenCalledWith({
      profileId: 'remote-a',
      adapterId: 'claude-code',
    });
    for (const call of Object.values(local)) expect(call).not.toHaveBeenCalled();
  });

  it('does not fall back to Local assets when the Remote capability is unavailable', async () => {
    const { local, remote } = installApi();
    render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:legacy-core',
      label: 'legacy-worker',
      profileId: 'remote-a',
      supportsNodeAssets: false,
      usable: true,
    }} />);

    expect(await screen.findByText(
      '当前 Remote Core 版本未提供 Worker 资产能力；请先升级远端部署。',
    )).toBeTruthy();
    expect(remote.listRemoteHostNodeAssets).not.toHaveBeenCalled();
    for (const call of Object.values(local)) expect(call).not.toHaveBeenCalled();
  });

  it('closes the viewer and ignores its stale content when Worker identity changes', async () => {
    const { remote } = installApi();
    let resolveContent!: (value: { content: string; revision: number }) => void;
    remote.getRemoteHostNodeAssetContent.mockImplementation(() => new Promise((resolve) => {
      resolveContent = resolve;
    }));
    const { rerender } = render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);

    await screen.findByText('agent-deck:claude-code:deep-review');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();

    rerender(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:2',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: '关闭' })).toBeNull());
    resolveContent({ content: '# stale Worker content', revision: 7 });
    await Promise.resolve();
    expect(screen.queryByText('# stale Worker content')).toBeNull();
  });
});
