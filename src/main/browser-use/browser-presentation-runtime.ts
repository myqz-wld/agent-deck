import { getFloatingWindow } from '../window';
import { BrowserPresentationController } from './browser-presentation-controller';
import { getBrowserViewHost } from './view-host';

let sharedController: BrowserPresentationController | null = null;

export function getBrowserPresentationController(): BrowserPresentationController {
  sharedController ??= new BrowserPresentationController({
    getWindow: () => getFloatingWindow().window,
    getHost: () => getBrowserViewHost(),
  });
  return sharedController;
}

export function setBrowserPresentationController(
  value: BrowserPresentationController | null,
): void {
  sharedController = value;
}
