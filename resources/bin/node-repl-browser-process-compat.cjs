'use strict';

const { isContext } = require('node:vm');

// Current ChatGPT node_repl builds lock a metadata-only process facade into their trusted VM
// realm, while the bundled Browser client immediately replaces that property with its own
// dependency shim. Intercept only that exact facade definition, keep it non-configurable, and
// restore the host intrinsic immediately. The real host process is never exposed to the VM.
const originalDefineProperty = Object.defineProperty;
const TRUSTED_PROCESS_KEYS = new Set([
  'arch',
  'cwd',
  'env',
  'off',
  'once',
  'pid',
  'platform',
]);

let installed = true;

function restoreDefineProperty() {
  if (!installed) return;
  installed = false;
  if (Object.defineProperty === definePropertyWithBrowserCompatibility) {
    Object.defineProperty = originalDefineProperty;
  }
}

function definePropertyWithBrowserCompatibility(target, property, descriptor) {
  if (isLockedTrustedProcessFacade(target, property, descriptor)) {
    restoreDefineProperty();
    return originalDefineProperty(target, property, {
      ...descriptor,
      writable: true,
    });
  }
  return originalDefineProperty(target, property, descriptor);
}

function isLockedTrustedProcessFacade(target, property, descriptor) {
  if (
    property !== 'process'
    || !isContext(target)
    || descriptor?.writable !== false
    || descriptor.configurable !== false
    || descriptor.enumerable !== false
  ) return false;

  const facade = descriptor.value;
  if (!facade || typeof facade !== 'object' || !Object.isFrozen(facade)) return false;
  const keys = Reflect.ownKeys(facade);
  if (
    keys.length !== TRUSTED_PROCESS_KEYS.size
    || keys.some((key) => typeof key !== 'string' || !TRUSTED_PROCESS_KEYS.has(key))
  ) return false;

  return typeof facade.arch === 'string'
    && typeof facade.cwd === 'function'
    && facade.env !== null
    && typeof facade.env === 'object'
    && Object.isFrozen(facade.env)
    && typeof facade.off === 'function'
    && typeof facade.once === 'function'
    && typeof facade.pid === 'number'
    && typeof facade.platform === 'string';
}

Object.defineProperty = definePropertyWithBrowserCompatibility;
const restoreTimer = setImmediate(restoreDefineProperty);
restoreTimer.unref?.();
