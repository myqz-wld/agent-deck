import { isJsonObject, type JsonObject } from '@contracts/index';
import { readOptionalProviderFile } from '@hosts/provider-state/provider-home-files';
import {
  LOCAL_WORKER_DESKTOP_STATE_PATH,
  LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS,
} from '@hosts/provider-state/local-worker-desktop-state';
import {
  resolveServerCoreProviderSettings,
  type ServerCoreProviderSettings,
} from './provider-settings';
import {
  resolveServerCoreSessionLifecycleSettings,
  type ServerCoreSessionLifecycleSettings,
} from './session-lifecycle-options';

export interface ServerCoreLocalWorkerDesktopState {
  readonly providerSettings: ServerCoreProviderSettings;
  readonly sessionLifecycle: ServerCoreSessionLifecycleSettings;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} has unsupported fields`);
  }
}

export function readServerCoreLocalWorkerDesktopState(
  providerHomeRoot: string,
): ServerCoreLocalWorkerDesktopState | null {
  const bytes = readOptionalProviderFile(
    providerHomeRoot,
    LOCAL_WORKER_DESKTOP_STATE_PATH,
    { private: true, maxBytes: 2 * 1024 * 1024 },
  );
  if (!bytes) return null;
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isJsonObject(raw)) throw new Error('Worker desktop state must be an object');
    exactKeys(raw, [
      'providerSettings',
      'schemaVersion',
      'sessionLifecycle',
    ], 'Worker desktop state');
    if (raw.schemaVersion !== 1) throw new Error('Worker desktop state schema is unsupported');
    if (!isJsonObject(raw.providerSettings)) {
      throw new Error('Worker desktop provider settings must be an object');
    }
    exactKeys(
      raw.providerSettings,
      LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS,
      'Worker desktop provider settings',
    );
    return Object.freeze({
      providerSettings: resolveServerCoreProviderSettings({
        providerSettings: raw.providerSettings,
      }),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({
        sessionLifecycle: raw.sessionLifecycle,
      }),
    });
  } finally {
    bytes.fill(0);
  }
}

export function mergeServerCoreLocalWorkerDesktopState(
  runtimeOptions: JsonObject,
  state: ServerCoreLocalWorkerDesktopState | null,
): JsonObject {
  if (!state) return runtimeOptions;
  const explicitProvider = isJsonObject(runtimeOptions.providerSettings)
    ? runtimeOptions.providerSettings
    : {};
  const projectedProvider = Object.fromEntries(
    LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS.map((key) => [
      key,
      state.providerSettings[key],
    ]),
  ) as JsonObject;
  return {
    ...runtimeOptions,
    providerSettings: { ...projectedProvider, ...explicitProvider },
    sessionLifecycle: runtimeOptions.sessionLifecycle ?? {
      schemaVersion: 1,
      ...state.sessionLifecycle,
    },
  };
}
