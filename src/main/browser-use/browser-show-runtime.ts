import { eventBus } from '../event-bus';
import { getFloatingWindow } from '../window';
import { getBrowserEngine } from './engine/registry';
import { getBrowserStateProjectionRegistry } from './browser-state-projection';
import { BrowserShowController } from './browser-show-controller';

let controller: BrowserShowController | null = null;

export function getBrowserShowController(): BrowserShowController {
  controller ??= new BrowserShowController({
    projection: getBrowserStateProjectionRegistry(),
    getOwner: (ownerId) => getBrowserEngine().peek({ kind: 'session', id: ownerId }),
    getWindow: () => getFloatingWindow().window,
    ensureWindow: () => {
      const floating = getFloatingWindow();
      const current = floating.window;
      return current && !current.isDestroyed() ? current : floating.create();
    },
    notify: (request) => eventBus.emit('browser-show-request', request),
  });
  return controller;
}
