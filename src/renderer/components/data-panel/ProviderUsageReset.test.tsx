// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsageSnapshot } from '@shared/types';
import { ProviderUsageReset } from './ProviderUsageReset';
import { ConfirmationDialogHost } from '../ConfirmationDialog';
import { cancelConfirmations } from '../../lib/confirm-dialog';
import { useUsageResetStore } from '../../stores/usage-reset-store';

const snapshot = (count: number | null = 4): ProviderUsageSnapshot => ({
  provider: 'codex-cli', label: 'Codex CLI', status: 'ok', windows: [], updatedAt: 1,
  resetCredits: { availableCount: count, accountId: 'test-account' },
});
const consume = vi.fn();
const view = (count: number | null = 4) => render(<><ConfirmationDialogHost />
  <ProviderUsageReset snapshot={snapshot(count)} sourceKey="local" consume={consume} />
</>);

beforeEach(() => { consume.mockReset().mockResolvedValue({ outcome: 'reset' }); useUsageResetStore.setState({ entries: {} }); });
afterEach(() => { cleanup(); cancelConfirmations(); });

describe('provider reset actions', () => {
  it.each([null, 0])('does not offer use for count %s', (count) => {
    view(count);
    expect(screen.queryByRole('button')).toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation and blocks a duplicate submission', async () => {
    let finish!: (value: unknown) => void;
    consume.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    view();
    fireEvent.click(screen.getByRole('button', { name: '为 Codex CLI 使用 1 次重置' }));
    expect(screen.getByText('使用 1 次重置后将剩余 3 次。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
    expect(consume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(consume).toHaveBeenCalledOnce());
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button'));
    expect(consume).toHaveBeenCalledOnce();
    await act(async () => { finish({ outcome: 'reset' }); });
    expect(screen.getByRole('status').textContent).toBe('额度已重置');
    // Counts come from the follow-up provider snapshot, never an optimistic subtraction.
    expect(screen.getByText('4 次')).toBeTruthy();
  });

  it('retains the idempotency key across an ambiguous failure and remount', async () => {
    consume.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ outcome: 'alreadyRedeemed' });
    const first = view();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    await screen.findByRole('alert');
    const key = consume.mock.calls[0][0].idempotencyKey;
    first.unmount();
    view();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: '重试本次' }));
    await waitFor(() => expect(consume).toHaveBeenCalledTimes(2));
    expect(consume.mock.calls[1][0].idempotencyKey).toBe(key);
    await screen.findByRole('status');
  });

  it('cancels confirmation when the original data source unmounts', async () => {
    const mounted = view();
    fireEvent.click(screen.getByRole('button'));
    mounted.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(consume).not.toHaveBeenCalled();
  });
});
