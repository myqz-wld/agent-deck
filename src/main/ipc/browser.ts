import { getBrowserPresentationController } from '@main/browser-use/browser-presentation-runtime';
import { getBrowserShowController } from '@main/browser-use/browser-show-runtime';
import { getBrowserStateProjectionRegistry } from '@main/browser-use/browser-state-projection';
import { makeSafeSend } from '@main/index/_deps';
import { getFloatingWindow } from '@main/window';
import { IpcEvent, IpcInvoke } from '@shared/ipc-channels';

import { on } from './_helpers';
import {
  parseBrowserPresentationBegin,
  parseBrowserPresentationPark,
  parseBrowserPresentationTab,
  parseBrowserPresentationUpdate,
  parseBrowserStateSource,
} from './browser-input';

export function registerBrowserIpc(): void {
  const controller = getBrowserPresentationController();
  const projection = getBrowserStateProjectionRegistry();
  const safeSend = makeSafeSend(() => getFloatingWindow().window);
  projection.subscribe((event) => {
    controller.observeProjection(event);
    safeSend(IpcEvent.BrowserStateChanged, event);
  });

  on(IpcInvoke.BrowserStateGet, (_event, value) =>
    controller.get(parseBrowserStateSource(value)));
  on(IpcInvoke.BrowserShowPending, (event) =>
    getBrowserShowController().getPending(event.sender.id));
  on(IpcInvoke.BrowserPresentationBegin, (event, value) => {
    const request = parseBrowserPresentationBegin(value);
    return controller.begin(event.sender.id, request.source, request.expectedRevision);
  });
  on(IpcInvoke.BrowserPresentationUpdate, (event, value) => {
    const request = parseBrowserPresentationUpdate(value);
    return controller.update(
      event.sender.id, request.leaseId, request.tabId, request.bounds,
    );
  });
  on(IpcInvoke.BrowserPresentationClose, (event, value) => {
    const request = parseBrowserPresentationTab(value);
    return controller.close(event.sender.id, request.leaseId, request.tabId);
  });
  on(IpcInvoke.BrowserPresentationPark, (event, value) => {
    const request = parseBrowserPresentationPark(value);
    return controller.park(event.sender.id, request.leaseId);
  });
  on(IpcInvoke.BrowserAnnotationCapture, (event, value) => {
    const request = parseBrowserPresentationTab(value);
    return controller.captureAnnotation(event.sender.id, request.leaseId, request.tabId);
  });
}
