// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { ConfirmationDialogHost } from './ConfirmationDialog';
import { cancelConfirmations, confirmDialog } from '../lib/confirm-dialog';
import { useModalFocus } from './use-modal-focus';

afterEach(() => { cleanup(); cancelConfirmations(); });

describe('application confirmation dialog', () => {
  it('queues decisions, defaults focus to cancel and never confirms on Escape', async () => {
    render(<ConfirmationDialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmDialog({ title: '第一个操作', message: '第一条说明' });
      second = confirmDialog({ title: '第二个操作', okLabel: '确认删除', destructive: true });
    });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await expect(first).resolves.toBe(false);
    expect(screen.getByRole('alertdialog', { name: '第二个操作' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await expect(second).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancels abandoned callers and all pending requests on host unmount', async () => {
    const view = render(<ConfirmationDialogHost />);
    const controller = new AbortController();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = confirmDialog({ title: '已关闭的来源', signal: controller.signal }); second = confirmDialog({ title: '待确认' }); });
    act(() => controller.abort());
    await expect(first).resolves.toBe(false);
    view.unmount();
    await expect(second).resolves.toBe(false);
  });

  it('closes only the top modal and restores the initiating focus', async () => {
    const outerClose = vi.fn();
    function Outer() {
      const ref = useRef<HTMLDivElement>(null);
      useModalFocus({ dialogRef: ref, onClose: outerClose });
      return <div ref={ref} role="dialog" tabIndex={-1}><button onClick={() => void confirmDialog({ title: '内层确认' })}>打开确认</button></div>;
    }
    render(<><Outer /><ConfirmationDialogHost /></>);
    const trigger = screen.getByRole('button', { name: '打开确认' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('button', { name: '取消' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(outerClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
