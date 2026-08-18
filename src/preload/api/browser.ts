import { ipcRenderer } from 'electron';

import type {
  BrowserPresentationBeginRequest,
  BrowserPresentationLease,
  BrowserPresentationParkRequest,
  BrowserPresentationResult,
  BrowserPresentationTabRequest,
  BrowserPresentationUpdateRequest,
  BrowserStateProjectionEvent,
  BrowserStateSnapshot,
  BrowserStateSource,
} from '@shared/browser-view';
import { IpcEvent, IpcInvoke } from '@shared/ipc-channels';

import { subscribe } from './_helpers';

export const browserApi = {
  getBrowserState: (source: BrowserStateSource): Promise<BrowserStateSnapshot | null> =>
    ipcRenderer.invoke(IpcInvoke.BrowserStateGet, source),
  beginBrowserPresentation: (
    request: BrowserPresentationBeginRequest,
  ): Promise<BrowserPresentationLease> =>
    ipcRenderer.invoke(IpcInvoke.BrowserPresentationBegin, request),
  updateBrowserPresentation: (
    request: BrowserPresentationUpdateRequest,
  ): Promise<BrowserPresentationResult> =>
    ipcRenderer.invoke(IpcInvoke.BrowserPresentationUpdate, request),
  selectBrowserPresentationTab: (
    request: BrowserPresentationTabRequest,
  ): Promise<BrowserPresentationResult> =>
    ipcRenderer.invoke(IpcInvoke.BrowserPresentationSelect, request),
  closeBrowserPresentationTab: (
    request: BrowserPresentationTabRequest,
  ): Promise<BrowserPresentationResult> =>
    ipcRenderer.invoke(IpcInvoke.BrowserPresentationClose, request),
  parkBrowserPresentation: (request: BrowserPresentationParkRequest): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.BrowserPresentationPark, request),
  onBrowserStateChanged: (
    callback: (event: BrowserStateProjectionEvent) => void,
  ): (() => void) => subscribe(IpcEvent.BrowserStateChanged, callback),
};
