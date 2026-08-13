// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@renderer/components/HeaderTokenRates', () => ({
  HeaderTokenRates: () => <div data-testid="token-rates" />,
}));

import { AppHeader } from '@renderer/components/AppHeader';

afterEach(cleanup);

function renderHeader(
  authority: 'unknown' | 'local' | 'remote',
  total: number | null = 1,
  remoteCapabilities: ReadonlySet<string> = new Set(),
  pending: number | null = 0,
  remoteUsable = true,
) {
  const onSourceChange = vi.fn();
  render(
    <AppHeader
      view="live"
      stats={{ total, waiting: 0, working: 1 }}
      pending={pending}
      pinned={false}
      compact={false}
      authority={authority}
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
      remoteCapabilities={remoteCapabilities}
      remoteUsable={remoteUsable}
      remoteUsage={null}
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
    fireEvent.click(screen.getByRole('option', { name: '远端 · 生产 Core' }));
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

  it('hides pages that the Remote Core does not advertise', () => {
    renderHeader('remote');
    expect(screen.queryByRole('button', { name: '问题' })).toBeNull();
    expect(screen.queryByRole('button', { name: '数据' })).toBeNull();
    expect(screen.queryByRole('button', { name: '实时' })).toBeNull();
    expect(screen.queryByRole('button', { name: '待处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '历史' })).toBeNull();
  });

  it('shows the shared Issues entry when the Remote Core advertises it', () => {
    renderHeader('remote', 1, new Set(['issues']));
    expect(screen.getByRole('button', { name: '问题' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '数据' })).toBeNull();
  });

  it('uses the same primary page catalog when Remote advertises all visible pages', () => {
    renderHeader('remote', 1, new Set([
      'session-console.read', 'pending.index.read', 'sessions.history',
      'teams', 'issues', 'usage',
    ]));
    expect(screen.getByRole('button', { name: '实时' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '待处理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '历史' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '团队' })).toBeNull();
    expect(screen.getByRole('button', { name: '问题' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '数据' })).toBeTruthy();
  });

  it('keeps the Local history label and does not invent a Remote total', () => {
    renderHeader('remote', null, new Set(['sessions.history']));
    expect(screen.getByText('会话总数未提供')).toBeTruthy();
    expect(screen.getByRole('button', { name: '历史' })).toBeTruthy();
  });

  it('disables authority-dependent controls while the source is unknown', () => {
    const onSourceChange = renderHeader('unknown', null, new Set(), null);
    expect((screen.getByRole('button', { name: '数据源' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '新建会话' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '资产库' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '设置' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '实时' })).toBeNull();
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it('distinguishes unknown, zero, and positive Pending totals', () => {
    const pendingCapability = new Set(['pending.index.read']);
    const unknown = renderHeader('remote', 1, pendingCapability, null);
    expect(screen.getByText(/待处理数量未提供/u)).toBeTruthy();
    cleanup();
    renderHeader('remote', 1, pendingCapability, 0);
    expect(screen.queryByText(/0 待处理/u)).toBeNull();
    cleanup();
    renderHeader('remote', 1, pendingCapability, 3);
    expect(screen.getByText('3 待处理')).toBeTruthy();
    expect(unknown).not.toHaveBeenCalled();
  });

  it('keeps stale Remote capabilities from enabling page and create actions offline', () => {
    renderHeader('remote', 1, new Set([
      'session-console.read', 'pending.index.read', 'sessions.history',
      'teams', 'issues', 'usage',
    ]), null, false);
    expect((screen.getByRole('button', { name: '实时' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '团队' })).toBeNull();
    expect((screen.getByRole('button', { name: '新建会话' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '数据源' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
