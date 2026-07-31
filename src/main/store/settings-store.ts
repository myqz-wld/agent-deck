import Store from 'electron-store';
import { randomBytes } from 'node:crypto';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('settings-store');

// electron-store v8's inherited private fields prevent TypeScript from preserving
// the small API surface used here when the class is parameterized.
interface StoreApi<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

let store: (Store<AppSettings> & StoreApi<AppSettings>) | null = null;

function ensure(): Store<AppSettings> & StoreApi<AppSettings> {
  if (store) return store;

  store = new Store<AppSettings>({
    name: 'agent-deck-settings',
    // electron-store may retain and mutate its defaults object.
    defaults: structuredClone(DEFAULT_SETTINGS),
  }) as Store<AppSettings> & StoreApi<AppSettings>;

  const isCanonicalToken = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  for (const key of ['hookServerToken', 'mcpServerToken'] as const) {
    if (isCanonicalToken(store.get(key))) continue;
    store.set(key, randomBytes(32).toString('hex'));
    logger.info(`[settings] generated new ${key}`);
  }

  return store;
}

function currentSettings(raw: AppSettings): AppSettings {
  return structuredClone(Object.fromEntries(
    (Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>).map((key) => [key, raw[key]]),
  )) as unknown as AppSettings;
}

export const settingsStore = {
  getAll(): AppSettings {
    return currentSettings(ensure().store);
  },
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return ensure().get(key);
  },
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    ensure().set(key, value);
  },
  patch(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getAll(), ...patch };
    const target = ensure();
    for (const [key, value] of Object.entries(patch)) {
      target.set(
        key as keyof AppSettings,
        value as AppSettings[keyof AppSettings],
      );
    }
    return next;
  },
};
