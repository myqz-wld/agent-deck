// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@renderer/components/HeaderTokenRates', () => ({
  HeaderTokenRates: () => <div data-testid="token-rates" />,
}));

import { AppHeader } from '@renderer/components/AppHeader';

afterEach(cleanup);

function renderHeader(sourceMode: 'local' | 'remote', total: number | null = 1) {
  const onSourceChange = vi.fn();
  render(
    <AppHeader
      view="live"
      stats={{ total, waiting: 0, working: 1 }}
      pending={0}
      pinned={false}
      compact={false}
      sourceMode={sourceMode}
      selectedRemoteProfileId="remote-a"
      remoteProfiles={[
        {
          id: 'local-a',
          label: '本机',
          scope: 'local',
          endpoint: null,
          credentials: { connectionCredentialConfigured: false },
        },
        {
          id: 'remote-a',
          label: '生产 Core',
          scope: 'remote',
          endpoint: {
            hostname: 'core.example.test',
            port: 22,
            username: 'agentdeck',
            hostKeyFingerprint: 'SHA256:test',
          },
          credentials: { connectionCredentialConfigured: true },
        },
      ]}
      onViewChange={vi.fn()}
      onSourceChange={onSourceChange}
      onOpenRemoteProfiles={vi.fn()}
      onOpenPending={vi.fn()}
      onNewSession={vi.fn()}
      onTogglePin={vi.fn()}
      onToggleCompact={vi.fn()}
      onOpenLibrary={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  return onSourceChange;
}

describe('AppHeader source selection', () => {
  it('uses one Local/Remote selector without a permanent remote business tab', () => {
    const onSourceChange = renderHeader('local');
    expect(screen.queryByRole('button', { name: '远程' })).toBeNull();
    expect(screen.getByRole('button', { name: '历史' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '数据源' }));
    fireEvent.click(screen.getByRole('option', { name: 'Remote · 生产 Core' }));
    expect(onSourceChange).toHaveBeenCalledWith('remote:remote-a');
  });

  it('places the source selector after Data and before the header icon controls', () => {
    renderHeader('local');
    const data = screen.getByRole('button', { name: '数据' });
    const source = screen.getByRole('button', { name: '数据源' });
    const pin = screen.getByRole('button', { name: '置顶' });
    expect(data.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(source.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides unsupported local-only pages in Remote mode', () => {
    renderHeader('remote');
    expect(screen.queryByRole('button', { name: '团队' })).toBeNull();
    expect(screen.queryByRole('button', { name: '问题' })).toBeNull();
    expect(screen.queryByRole('button', { name: '数据' })).toBeNull();
    expect(screen.getByRole('button', { name: '实时' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '待处理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话摘要' })).toBeTruthy();
  });

  it('labels Remote history as bounded summaries and does not invent a total', () => {
    renderHeader('remote', null);
    expect(screen.getByText('会话总数未提供')).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话摘要' })).toBeTruthy();
  });
});
