// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteHostProfileDto,
  RemoteHostStateDto,
} from '@shared/remote-host';
import type { RemoteHostSnapshotState } from '@renderer/remote-host/use-remote-host-snapshot';
import { RemoteHostManagerDialog } from './RemoteHostManagerDialog';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.clearAllMocks();
});

function remoteProfile(index: number): RemoteHostProfileDto {
  return {
    id: `remote-${index}`,
    label: `Remote Core ${index}`,
    scope: 'remote',
    endpoint: {
      hostname: `core-${index}.example.test`,
      port: 22,
      username: 'agentdeck',
      hostKeyFingerprint: `SHA256:${index}`,
    },
    credentials: { connectionCredentialConfigured: true },
  };
}

function remoteState(
  profileId: string,
  status: RemoteHostStateDto['status'] = 'offline',
  error: RemoteHostStateDto['error'] = null,
): RemoteHostStateDto {
  return {
    profileId,
    status,
    recovery: null,
    authoritativeCoreId: status === 'connected' ? `core:${profileId}` : null,
    workerGeneration: status === 'connected' ? 1 : null,
    capabilities: [],
    eventRevision: 0,
    error,
  };
}

function hosts(
  profiles: RemoteHostProfileDto[],
  states: RemoteHostStateDto[],
  overrides: Partial<RemoteHostSnapshotState> = {},
): RemoteHostSnapshotState {
  return {
    snapshot: {
      revision: 1,
      sourceMode: 'remote',
      selectedRemoteProfileId: profiles[0]?.id ?? null,
      profiles,
      states,
    },
    dataRevisionByProfile: new Map(),
    resourceRevisionsByProfile: new Map(),
    busy: false,
    error: null,
    snapshotError: null,
    refresh: vi.fn(async () => undefined),
    addProfile: vi.fn(async () => undefined),
    updateProfile: vi.fn(async () => undefined),
    removeProfile: vi.fn(async () => undefined),
    selectProfile: vi.fn(async () => undefined),
    setSourceMode: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

describe('RemoteHostManagerDialog', () => {
  it('uses a compact single-column layout with in-context connection controls', () => {
    const profile = remoteProfile(1);
    render(<RemoteHostManagerDialog
      open
      hosts={hosts([profile], [remoteState(profile.id, 'connected')])}
      onClose={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: '远程数据源' });
    expect(dialog.getAttribute('data-layout')).toBe('single-column');
    expect(dialog.className).toContain('w-[min(34rem,92%)]');
    expect(dialog.querySelector('aside')).toBeNull();
    expect(screen.queryByText(/选择左侧连接/)).toBeNull();

    const card = screen.getByTestId('remote-connection-card');
    expect(within(card).getByText('Remote Core 1')).toBeTruthy();
    expect(within(card).getByText('agentdeck@core-1.example.test:22')).toBeTruthy();
    expect(within(card).getByText('已连接')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '断开' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: '删除配置' })).toBeTruthy();
  });

  it('uses Remote accent and status colors instead of opaque gray connection fills', () => {
    const profiles = [remoteProfile(1), remoteProfile(2)];
    render(<RemoteHostManagerDialog
      open
      hosts={hosts(profiles, [
        remoteState(profiles[0]!.id, 'connected'),
        remoteState(profiles[1]!.id, 'offline'),
      ])}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('1/2 已连接')).toBeTruthy();
    const [selected, unselected] = screen.getAllByTestId('remote-connection-card');
    expect(selected!.className).toContain('from-blue-500/[0.12]');
    expect(selected!.className).not.toContain('bg-white/[0.08]');
    expect(within(selected!).getByText('默认连接')).toBeTruthy();
    expect(within(selected!).getByText('已连接').className)
      .toContain('bg-emerald-400/[0.07]');
    expect(unselected!.className).toContain('bg-black/[0.10]');
    expect(within(unselected!).queryByText('默认连接')).toBeNull();
  });

  it('renders a compact empty state without reserving a detail pane', () => {
    render(<RemoteHostManagerDialog open hosts={hosts([], [])} onClose={vi.fn()} />);

    expect(screen.getByText('还没有远程连接')).toBeTruthy();
    expect(screen.getByText(/点击右上角“添加”/)).toBeTruthy();
    expect(screen.queryByTestId('remote-connection-list')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('aside')).toBeNull();
  });

  it('keeps many connections and long errors inside the vertical scroll column', () => {
    const profiles = Array.from({ length: 18 }, (_, index) => remoteProfile(index + 1));
    profiles[0] = {
      ...profiles[0],
      label: `Remote Core ${'with-a-long-label-'.repeat(12)}`,
      endpoint: {
        ...profiles[0].endpoint!,
        hostname: `${'long-host-segment.'.repeat(12)}example.test`,
      },
    };
    const longError = `连接错误：${'远端握手信息'.repeat(40)}`;
    const states = profiles.map((profile, index) => remoteState(
      profile.id,
      index === 0 ? 'incompatible' : 'offline',
      index === 0 ? { code: 'protocol_violation', message: longError } : null,
    ));
    render(<RemoteHostManagerDialog
      open
      hosts={hosts(profiles, states, { error: `全局错误：${'重试失败'.repeat(30)}` })}
      onClose={vi.fn()}
    />);

    const list = screen.getByTestId('remote-connection-list');
    expect(screen.getAllByTestId('remote-connection-card')).toHaveLength(18);
    expect(list.parentElement?.className).toContain('overflow-y-auto');
    expect(screen.getByText(profiles[0].label).className).toContain('truncate');
    expect(screen.getByText(
      `agentdeck@${profiles[0].endpoint!.hostname}:22`,
    ).className).toContain('truncate');
    expect(screen.getByText(longError).className).toContain('break-words');
    expect(screen.getByRole('alert').className).toContain('break-words');
  });

  it('keeps recoverable Worker-offline connections on the disconnect path', () => {
    const profile = remoteProfile(1);
    const state = {
      ...remoteState(profile.id),
      recovery: 'worker-offline' as const,
    };
    const current = hosts([profile], [state]);
    render(<RemoteHostManagerDialog open hosts={current} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '断开' }));
    expect(current.disconnect).toHaveBeenCalledWith(profile.id);
    expect(current.connect).not.toHaveBeenCalled();
  });

  it('runs select, connect, edit, and confirmed remove actions from the same card', async () => {
    const profile = remoteProfile(1);
    const current = hosts([profile], [remoteState(profile.id)]);
    const confirmDialog = vi.fn(async () => true);
    window.api = { confirmDialog } as unknown as typeof window.api;
    render(<RemoteHostManagerDialog open hosts={current} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: `选择连接 ${profile.label}` }));
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    expect(current.selectProfile).toHaveBeenCalledWith(profile.id);
    expect(current.connect).toHaveBeenCalledWith(profile.id);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByText('编辑远程连接')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭远程连接表单' }));

    fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    await waitFor(() => expect(current.removeProfile).toHaveBeenCalledWith(profile.id));
  });

  it('disables mutating card actions while a connection operation is busy', () => {
    const profile = remoteProfile(1);
    render(<RemoteHostManagerDialog
      open
      hosts={hosts([profile], [remoteState(profile.id)], { busy: true })}
      onClose={vi.fn()}
    />);

    for (const name of ['添加', '连接', '编辑', '删除配置']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('discards an edit overlay when the dialog closes or its profile disappears', () => {
    const profile = remoteProfile(1);
    const current = hosts([profile], [remoteState(profile.id)]);
    const rendered = render(
      <RemoteHostManagerDialog open hosts={current} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByText('编辑远程连接')).toBeTruthy();

    rendered.rerender(
      <RemoteHostManagerDialog open={false} hosts={current} onClose={vi.fn()} />,
    );
    rendered.rerender(
      <RemoteHostManagerDialog open hosts={hosts([], [])} onClose={vi.fn()} />,
    );
    expect(screen.queryByText('编辑远程连接')).toBeNull();
    expect(screen.getByText('还没有远程连接')).toBeTruthy();
  });

  it('traps keyboard focus and restores the opening control after close', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const current = hosts([remoteProfile(1)], [remoteState('remote-1')]);
    const view = render(
      <RemoteHostManagerDialog open hosts={current} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: '远程数据源' });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    view.rerender(<RemoteHostManagerDialog open={false} hosts={current} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
