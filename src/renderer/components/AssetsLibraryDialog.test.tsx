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
        location: '应用内置/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md',
        tools: null,
        model: null,
        thinking: null,
        provider: null,
        origin: null,
        pluginName: null,
        runtimeName: null,
        runtimeDefaults: null,
        runtimeOverride: null,
      }, {
        adapterId: 'claude-code',
        kind: 'agent',
        source: 'bundled',
        name: 'reviewer-claude',
        qualifiedName: 'agent-deck:claude-code:reviewer-claude',
        description: 'Reviewer',
        location: '应用内置/claude-config/agent-deck-plugin/agents/reviewer-claude.md',
        tools: 'Read, Grep',
        model: 'deepseek-v4-flash[1m]',
        thinking: 'max',
        provider: 'deepseek',
        origin: null,
        pluginName: null,
        runtimeName: null,
        runtimeDefaults: { model: 'sonnet', thinking: 'high', provider: null },
        runtimeOverride: {
          model: 'deepseek-v4-flash[1m]', thinking: 'max', provider: 'deepseek',
        },
      }],
      assetsTruncated: false,
      injection: INJECTION,
      readOnlyReason: '这里展示当前远端环境中的配置，不能在此页面修改。',
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
  it('shows the Worker effective Reviewer Agent configuration and modified state', async () => {
    installApi();
    render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Agents' }));
    expect(await screen.findByText('agent-deck:claude-code:reviewer-claude')).toBeTruthy();
    expect(screen.getByText('deepseek-v4-flash[1m]')).toBeTruthy();
    expect(screen.getByText('已修改内建 Agent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /配置/u })).toBeNull();
  });

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
    expect(screen.getByText('远端资产')).toBeTruthy();
    expect(screen.getAllByText('远端资产仅供查看。')).toHaveLength(1);
    expect(screen.queryByText('个人配置/.claude/skills/')).toBeNull();
    expect(screen.queryByText('这里展示当前远端环境中的配置，不能在此页面修改。')).toBeNull();
    for (const toggle of screen.getAllByRole('checkbox')) {
      expect((toggle as HTMLInputElement).disabled).toBe(true);
    }

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(await screen.findByText('# Worker deep review')).toBeTruthy();
    expect(screen.getByText('远端内容')).toBeTruthy();
    expect(screen.queryByText(
      '应用内置/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md',
    )).toBeNull();
    expect(screen.queryByRole('button', { name: '显示文件' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    fireEvent.click(screen.getByRole('button', { name: '应用约定' }));
    const convention = await screen.findByRole('textbox', {
      name: 'Claude Code 应用约定（只读）',
    });
    expect((convention as HTMLTextAreaElement).value).toBe('# Worker CLAUDE.md');
    expect((convention as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', {
      name: '放大查看 Claude Code 应用约定',
    }));
    expect(screen.getByRole('dialog', { name: '查看 Claude Code 应用约定' })).toBeTruthy();
    expect(screen.getByRole('textbox', {
      name: 'Claude Code 应用约定（放大查看，只读）',
    })).toBeTruthy();

    expect(remote.listRemoteHostNodeAssets).toHaveBeenCalledWith({ profileId: 'remote-a' });
    expect(remote.getRemoteHostNodeAssetContent).toHaveBeenCalledWith({
      profileId: 'remote-a',
      adapterId: 'claude-code',
      kind: 'skill',
      source: 'bundled',
      name: 'deep-review',
      qualifiedName: 'agent-deck:claude-code:deep-review',
      location: '应用内置/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md',
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
      '当前远端版本不支持读取资产，请升级后重试。',
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

  it('clears Remote assets and ignores stale content when the same Worker disconnects', async () => {
    const { local, remote } = installApi();
    let resolveContent!: (value: { content: string; revision: number }) => void;
    remote.getRemoteHostNodeAssetContent.mockImplementation(() => new Promise((resolve) => {
      resolveContent = resolve;
    }));
    const remoteProps = {
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
    } as const;
    const { rerender } = render(
      <AssetsLibraryDialog open onClose={vi.fn()} remote={{ ...remoteProps, usable: true }} />,
    );

    await screen.findByText('agent-deck:claude-code:deep-review');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();

    rerender(
      <AssetsLibraryDialog open onClose={vi.fn()} remote={{ ...remoteProps, usable: false }} />,
    );
    expect(await screen.findByText('当前远端环境尚未连接，暂时无法读取资产。')).toBeTruthy();
    expect(screen.queryByText('agent-deck:claude-code:deep-review')).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();

    resolveContent({ content: '# stale Worker content', revision: 7 });
    await Promise.resolve();
    expect(screen.queryByText('# stale Worker content')).toBeNull();
    for (const call of Object.values(local)) expect(call).not.toHaveBeenCalled();
  });

  it('never renders content from a newer same-Worker catalog snapshot', async () => {
    const { remote } = installApi();
    remote.getRemoteHostNodeAssetContent.mockResolvedValue({
      content: '# replaced after list',
      revision: 8,
    });
    render(<AssetsLibraryDialog open onClose={vi.fn()} remote={{
      identity: 'remote-a:core-a:1',
      label: 'aws-relay-on-mac',
      profileId: 'remote-a',
      supportsNodeAssets: true,
      usable: true,
    }} />);

    await screen.findByText('agent-deck:claude-code:deep-review');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(remote.listRemoteHostNodeAssets).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('# replaced after list')).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});
