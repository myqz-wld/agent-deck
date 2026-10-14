// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionAdapterId, SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { ConfirmationDialogHost } from '../../ConfirmationDialog';
import { ComposerSdk } from '../ComposerSdk';
import { RemoteSessionRuntimeControls } from '../RemoteSessionRuntimeControls';
import { SessionSandboxControls } from '../composer-sdk/SessionSandboxControls';

const adapters: SessionAdapterId[] = ['claude-code', 'codex-cli', 'grok-build'];
const cases = adapters.flatMap(adapterId => (['local', 'remote'] as const).map(surface => ({ adapterId, surface })));
const mutation = vi.fn().mockResolvedValue(undefined);

function session(adapterId: SessionAdapterId, permissionMode: 'auto' | 'bypassPermissions' = 'auto', id = 'session-a'): SessionRecord {
  return { id, agentId: adapterId, cwd: '/repo', title: 'Example', source: 'sdk', lifecycle: 'active',
    activity: 'idle', startedAt: 0, lastEventAt: 0, endedAt: null, archivedAt: null,
    permissionMode, codexApprovalPolicy: permissionMode === 'auto' ? 'on-request' : 'never',
    claudeCodeSandbox: 'strict', codexSandbox: 'read-only', grokSandbox: 'read-only' };
}

function Controls({ adapterId, surface, kind, mode = 'auto', id = 'session-a' }: {
  adapterId: SessionAdapterId; surface: 'local' | 'remote'; kind: 'permission' | 'sandbox';
  mode?: 'auto' | 'bypassPermissions'; id?: string;
}) {
  const record = session(adapterId, mode, id);
  return <>
    {surface === 'remote'
      ? <RemoteSessionRuntimeControls adapterId={adapterId} identity={`remote:${id}`} busy={false} canWrite
          values={{ permissionMode: mode, claudeCodeSandbox: 'strict', codexSandbox: 'read-only', grokSandbox: 'read-only' }}
          onApply={mutation} />
      : kind === 'permission' ? <ComposerSdk session={record} />
        : <SessionSandboxControls session={record} turnBusy={false} />}
    <ConfirmationDialogHost />
  </>;
}

beforeEach(() => {
  mutation.mockClear();
  useSessionStore.setState({ sessions: new Map(), composerBySession: new Map(), composerAliases: new Map(), composerRequestSequence: 0 });
  Object.defineProperty(window, 'api', { configurable: true, value: {
    listAdapters: async () => adapters.map(id => ({ id, capabilities: { canSetPermissionMode: true } })),
    listClaudeGatewayProfiles: async () => [], listCodexGatewayProfiles: async () => [],
    listAdapterSessionCommands: async () => [], listPendingOutgoingMessages: async () => [],
    onAgentEvent: () => () => undefined, setAdapterPermissionMode: mutation,
    restartWithClaudeCodeSandbox: mutation, restartWithGrokSandbox: mutation, setCodexSandbox: mutation,
  } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'api'); });

describe.each(cases)('$surface $adapterId runtime confirmation', ({ adapterId, surface }) => {
  it.each(['permission', 'sandbox'] as const)('requires approval for an unrestricted %s change and honors cancel', async kind => {
    render(<Controls adapterId={adapterId} surface={surface} kind={kind} />);
    const field = kind === 'permission' ? '权限' : '沙盒';
    const option = kind === 'permission' ? '不再询问' : '完全开放';
    fireEvent.click(await screen.findByLabelText(field));
    const entry = screen.getByRole('option', { name: option });
    expect(entry.querySelector('svg.text-status-waiting')).not.toBeNull();
    fireEvent.click(entry);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(kind === 'permission' ? '切换到不再询问？' : '将沙盒设为完全开放？');
    expect(mutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mutation).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByLabelText(field));
    fireEvent.click(screen.getByRole('option', { name: option }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    const value = kind === 'permission' ? 'bypassPermissions' : adapterId === 'codex-cli' ? 'danger-full-access' : 'off';
    const key = kind === 'permission' ? 'permissionMode' : adapterId === 'claude-code'
      ? 'claudeCodeSandbox' : adapterId === 'codex-cli' ? 'codexSandbox' : 'grokSandbox';
    if (surface === 'remote') expect(mutation).toHaveBeenCalledWith({ [key]: value });
    else expect(mutation.mock.calls[0]?.slice(0, 3)).toEqual([adapterId, 'session-a', value]);
  });

  it('shows the same warning on the selected no-prompt value and applies auto directly', async () => {
    render(<Controls adapterId={adapterId} surface={surface} kind="permission" mode="bypassPermissions" />);
    const field = await screen.findByLabelText('权限');
    expect(field.querySelector('svg.text-status-waiting')).not.toBeNull();
    fireEvent.click(field);
    fireEvent.click(screen.getByRole('option', { name: '自动审批' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('applies a bounded sandbox directly', async () => {
    render(<Controls adapterId={adapterId} surface={surface} kind="sandbox" />);
    fireEvent.click(await screen.findByLabelText('沙盒'));
    fireEvent.click(screen.getByRole('option', { name: '工作目录可写' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancels pending permission confirmation when the selected session changes', async () => {
    const view = render(<Controls adapterId={adapterId} surface={surface} kind="permission" />);
    fireEvent.click(await screen.findByLabelText('权限'));
    fireEvent.click(screen.getByRole('option', { name: '不再询问' }));
    await screen.findByRole('alertdialog');
    view.rerender(<Controls adapterId={adapterId} surface={surface} kind="permission" id="session-b" />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mutation).not.toHaveBeenCalled();
  });
});
