import type { JsonObject } from '@contracts/index';

import {
  mergeServerCoreLocalWorkerDesktopState,
  readServerCoreLocalWorkerDesktopState,
} from './local-worker-desktop-state';
import {
  resolveServerCoreProviderSettings,
  type ServerCoreProviderSettings,
} from './provider-settings';
import {
  resolveServerCoreSessionLifecycleSettings,
  type ServerCoreSessionLifecycleSettings,
} from './session-lifecycle-options';
import { validateServerCoreProviderContainerOption } from './runtime-provider-container';

const RUNTIME_OPTION_KEYS = new Set([
  'projects', 'providerContainer', 'providerSettings', 'sessionLifecycle',
]);

export interface ServerCoreResolvedRuntimeSettings {
  readonly runtimeOptions: JsonObject;
  readonly providerSettings: ServerCoreProviderSettings;
  readonly sessionLifecycle: ServerCoreSessionLifecycleSettings;
}

export function validateServerCoreRuntimeOptions(runtimeOptions: JsonObject): void {
  for (const key of Object.keys(runtimeOptions)) {
    if (!RUNTIME_OPTION_KEYS.has(key)) {
      throw new Error(`runtimeOptions.${key} is unsupported`);
    }
  }
  validateServerCoreProviderContainerOption(runtimeOptions);
  resolveServerCoreSessionLifecycleSettings(runtimeOptions);
}

/** Resolves the shared Full settings or the Local Worker desktop projection at one boundary. */
export function resolveServerCoreRuntimeSettings(
  runtimeOptions: JsonObject,
  providerHomeRoot: string,
  localWorker: boolean,
): ServerCoreResolvedRuntimeSettings {
  const desktopState = localWorker
    ? readServerCoreLocalWorkerDesktopState(providerHomeRoot)
    : null;
  const merged = mergeServerCoreLocalWorkerDesktopState(runtimeOptions, desktopState);
  validateServerCoreRuntimeOptions(merged);
  return Object.freeze({
    runtimeOptions: merged,
    providerSettings: resolveServerCoreProviderSettings(merged),
    sessionLifecycle: resolveServerCoreSessionLifecycleSettings(merged),
  });
}
