import Store from 'electron-store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';

// electron-store v10 继承自 conf v14 的 ESM 类（含 `#private`），
// TS 推断子类时丢失了 store/get/set 等成员。这里用接口断言显式补回。
interface StoreApi<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  delete<K extends keyof T>(key: K): void;
  has<K extends keyof T>(key: K): boolean;
}

/**
 * 已被移除的字段名。每次启动时从持久化文件里清理一次，
 * 避免历史 install 留下的孤儿字段（如 anthropicApiKey）越积越多。
 */
const REMOVED_KEYS: readonly string[] = ['anthropicApiKey'];

let store: (Store<AppSettings> & StoreApi<AppSettings>) | null = null;

function ensure(): Store<AppSettings> & StoreApi<AppSettings> {
  if (!store) {
    store = new Store<AppSettings>({
      name: 'agent-deck-settings',
      defaults: DEFAULT_SETTINGS,
    }) as Store<AppSettings> & StoreApi<AppSettings>;

    // 清理已弃用字段（idempotent：再次启动时即便没有这些键也无副作用）
    const raw = store.store as unknown as Record<string, unknown>;
    const looseDelete = store as unknown as { delete: (k: string) => void };
    for (const key of REMOVED_KEYS) {
      if (key in raw) {
        looseDelete.delete(key);
        console.log(`[settings] removed legacy field "${key}"`);
      }
    }
  }
  return store;
}

export const settingsStore = {
  getAll(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...ensure().store };
  },
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return ensure().get(key);
  },
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    ensure().set(key, value);
  },
  patch(patch: Partial<AppSettings>): AppSettings {
    const current = this.getAll();
    const next = { ...current, ...patch };
    const s = ensure();
    for (const [k, v] of Object.entries(patch)) {
      s.set(k as keyof AppSettings, v as AppSettings[keyof AppSettings]);
    }
    return next;
  },
};

