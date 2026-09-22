// @vitest-environment happy-dom
import { useRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPresentationLease, BrowserStateSnapshot } from '@shared/browser-view';
import { useModalFocus } from '../use-modal-focus';
import { IabPanel } from './IabPanel';

const source = { kind: 'local' as const, sessionId: 'session-a' };
const snapshot: BrowserStateSnapshot = {
  protocolVersion: 1, source, revision: 1,
  tabs: [{ id: 1, active: true, title: 'Example', url: 'about:blank', viewportRevision: 1 }],
};
const bounds = { x: 10, y: 100, width: 420, height: 480 };
const begin = vi.fn();
const update = vi.fn();
const park = vi.fn();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function Dialog({ name }: { name: string }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({ dialogRef, onClose: () => {} });
  return <div ref={dialogRef} role="dialog" aria-label={name} tabIndex={-1} />;
}

function Fixture({ modalOpen = false, nestedOpen = false }: {
  modalOpen?: boolean;
  nestedOpen?: boolean;
}) {
  return <>
    <IabPanel source={source} snapshot={snapshot} />
    {modalOpen && <Dialog name="New session" />}
    {nestedOpen && <Dialog name="Directory picker" />}
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  let leaseNumber = 0;
  begin.mockImplementation(async () => ({ leaseId: `lease-${++leaseNumber}`, source, snapshot }));
  update.mockImplementation(async () => ({ snapshot, appliedBounds: bounds }));
  park.mockResolvedValue(true);
  window.api = {
    beginBrowserPresentation: begin,
    updateBrowserPresentation: update,
    parkBrowserPresentation: park,
  } as unknown as typeof window.api;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('parks an existing native view until all dialogs close, then reacquires unchanged state', async () => {
  const view = render(<Fixture />);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());

  view.rerender(<Fixture modalOpen />);
  await waitFor(() => expect(park).toHaveBeenCalledWith({ leaseId: 'lease-1' }));
  view.rerender(<Fixture modalOpen nestedOpen />);
  view.rerender(<Fixture modalOpen />);
  await act(flush);
  expect(begin).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();

  view.rerender(<Fixture />);
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(begin).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenLastCalledWith({ leaseId: 'lease-2', tabId: 1, bounds });
});

it('does not begin or place a native view when mounted behind a dialog', async () => {
  const view = render(<Fixture modalOpen />);
  await act(flush);
  expect(begin).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();

  view.rerender(<Fixture />);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
});

it('parks a late lease response without presenting it over the dialog', async () => {
  let resolveLease!: (lease: BrowserPresentationLease) => void;
  begin.mockImplementationOnce(() => new Promise((done) => { resolveLease = done; }));
  const view = render(<Fixture />);
  await act(flush);
  view.rerender(<Fixture modalOpen />);
  await act(async () => {
    resolveLease({ leaseId: 'late-lease', source, snapshot });
    await flush();
  });
  expect(park).toHaveBeenCalledWith({ leaseId: 'late-lease' });
  expect(update).not.toHaveBeenCalled();

  view.rerender(<Fixture />);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update).toHaveBeenLastCalledWith({ leaseId: 'lease-1', tabId: 1, bounds });
});
