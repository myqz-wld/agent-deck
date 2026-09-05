import { getFloatingWindow } from '../window';
import { BrowserPresentationController } from './browser-presentation-controller';
import { getBrowserViewHost } from './view-host';
import { getBrowserShowController } from './browser-show-runtime';

let sharedController: BrowserPresentationController | null = null;

export function getBrowserPresentationController(): BrowserPresentationController {
  sharedController ??= new BrowserPresentationController({
    getWindow: () => getFloatingWindow().window,
    getHost: () => getBrowserViewHost(),
    onPresented: (rendererId, source, tabId) =>
      getBrowserShowController().observePresentation(rendererId, source, tabId),
  });
  return sharedController;
}

export function setBrowserPresentationController(
  value: BrowserPresentationController | null,
): void {
  sharedController = value;
}
