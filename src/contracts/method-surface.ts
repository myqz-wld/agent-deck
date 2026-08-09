import { AccessSurface, type AccessSurface as Surface } from './access';
import { CORE_METHOD_METADATA, type CoreMethod } from './methods';

const ALL_CORE_METHODS = Object.freeze(Object.keys(CORE_METHOD_METADATA) as CoreMethod[]);
const FEISHU_CORE_METHODS = Object.freeze(
  ALL_CORE_METHODS.filter(
    (method) => CORE_METHOD_METADATA[method].feishu === 'session-console',
  ),
);
const NO_CORE_METHODS: readonly CoreMethod[] = Object.freeze([]);

export function coreMethodsForSurface(surface: Surface): readonly CoreMethod[] {
  switch (surface) {
    case AccessSurface.DesktopFull:
      return ALL_CORE_METHODS;
    case AccessSurface.FeishuSessionConsole:
      return FEISHU_CORE_METHODS;
    case AccessSurface.RelayWorkerAttach:
      return NO_CORE_METHODS;
  }
}

export function isCoreMethod(value: string): value is CoreMethod {
  return Object.prototype.hasOwnProperty.call(CORE_METHOD_METADATA, value);
}

export function isCoreMethodAllowed(surface: Surface, method: string): method is CoreMethod {
  return isCoreMethod(method) && coreMethodsForSurface(surface).includes(method);
}
