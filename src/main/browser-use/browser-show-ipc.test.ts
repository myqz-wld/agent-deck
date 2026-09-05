import { beforeEach, expect, it, vi } from 'vitest';
import { IpcEvent, IpcInvoke } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn(),
  pending: vi.fn(), subscribe: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, off: mocks.off },
}));
vi.mock('@main/browser-use/browser-show-runtime', () => ({
  getBrowserShowController: () => ({ getPending: mocks.pending }),
}));
vi.mock('@main/browser-use/browser-presentation-runtime', () => ({
  getBrowserPresentationController: () => ({}),
}));
vi.mock('@main/browser-use/browser-state-projection', () => ({
  getBrowserStateProjectionRegistry: () => ({ subscribe: mocks.subscribe }),
}));
vi.mock('@main/index/_deps', () => ({ makeSafeSend: () => vi.fn() }));
vi.mock('@main/window', () => ({ getFloatingWindow: () => ({ window: null }) }));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => ({ warn: vi.fn() }) } }));
import { registerBrowserIpc } from '../ipc/browser';
import { browserApi } from '../../preload/api/browser';

beforeEach(() => vi.clearAllMocks());
it('registers the shared show channel and derives its owner window only from IPC sender', async () => {
  registerBrowserIpc();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === IpcInvoke.BrowserShowPending)?.[1];
  handler({ sender: { id: 73 } }, { rendererId: 99 });
  expect(mocks.pending).toHaveBeenCalledWith(73);
  await browserApi.getPendingBrowserShow();
  expect(mocks.invoke).toHaveBeenCalledWith(IpcInvoke.BrowserShowPending);
});
it('passes show requests and completion through typed preload and unsubscribes exactly', () => {
  const callback = vi.fn();
  const off = browserApi.onBrowserShowRequested(callback);
  const handler = mocks.on.mock.calls[0]?.[1];
  expect(mocks.on.mock.calls[0]?.[0]).toBe(IpcEvent.BrowserShowRequested);
  const request = { requestId: 'show', source: { kind: 'local', sessionId: 'owner' }, tabId: 1 };
  handler({}, request);
  handler({}, null);
  expect(callback.mock.calls).toEqual([[request], [null]]);
  off();
  expect(mocks.off).toHaveBeenCalledWith(IpcEvent.BrowserShowRequested, handler);
});
