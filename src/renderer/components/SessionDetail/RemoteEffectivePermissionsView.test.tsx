// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionPermissionsGetResult } from '@contracts/index';
import { RemoteEffectivePermissionsView } from './RemoteEffectivePermissionsView';

function permissionData(): SessionPermissionsGetResult {
  return {
    sessionId: 'session-a',
    adapterId: 'codex-cli',
    effective: {
      adapterId: 'codex-cli',
      approvalPolicy: 'on-request',
      approvalPolicySource: 'session',
      sandbox: 'workspace-write',
      sandboxSource: 'session',
    },
    workspace: { read: 'allowed', write: 'allowed', network: 'provider-default' },
    rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
    revision: 1,
  };
}

afterEach(cleanup);

describe('RemoteEffectivePermissionsView recovery', () => {
  it('offers retry when the initial projection fails', () => {
    const onRefresh = vi.fn();
    render(<RemoteEffectivePermissionsView
      data={null}
      loading={false}
      error="读取失败"
      onRefresh={onRefresh}
    />);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('retains the last projection when a refresh fails', () => {
    render(<RemoteEffectivePermissionsView
      data={permissionData()}
      loading={false}
      error="读取失败"
      onRefresh={vi.fn()}
    />);

    expect(screen.getByText('Codex CLI 当前生效权限')).toBeTruthy();
    expect(screen.getByText('读取失败，当前显示上次结果。')).toBeTruthy();
  });
});
