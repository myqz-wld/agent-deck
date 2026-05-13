import Store from 'electron-store';
import { randomBytes } from 'node:crypto';
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
const REMOVED_KEYS: readonly string[] = [
  'anthropicApiKey',
  // R3.E6 (PR-B) 硬切删除：agent teams 老 backend 下线
  // —— inbox 协议 / Claude Code experimental teams flag / autoApprove 三档 全废
  'agentTeamsEnabled',
  'autoApproveTeammateMode',
  // CHANGELOG_100 / plan mcp-tool-simplify-20260514：删 wait_reply tool 联动删 idle 阈值
  'mcpWaitReplyIdleQuietMs',
  // CHANGELOG_68：R3.E12 一次性「即将硬切」弹窗 + LegacyTeamExportSection 整体下线
  // —— PR-B 硬切已上线 + R4 已实施，备份窗口期已过，相关 IPC / dialog / settings 字段全废
  'r3LegacyExportNoticeAcked',
  // Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：透明 / 置顶解耦
  // 重命名为 windowTransparent + 解耦语义。一次性 migration 在 ensure() 内做（旧值 →
  // 新字段），随后 REMOVED_KEYS 自动清孤儿字段，老用户偏好不丢。
  'transparentWhenPinned',
];

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
    // Phase 5 Step 5.6 一次性 migration：transparentWhenPinned → windowTransparent。
    // 必须在 REMOVED_KEYS delete 循环之前做（delete 后旧值就拿不到了）。仅在用户从未
    // 设置过新字段且持有旧字段值时迁移；否则用户已经主动设了 windowTransparent 不动。
    if ('transparentWhenPinned' in raw && !('windowTransparent' in raw)) {
      const legacy = raw['transparentWhenPinned'];
      if (typeof legacy === 'boolean') {
        store.set('windowTransparent', legacy);
        console.log(`[settings] migrated transparentWhenPinned=${legacy} → windowTransparent`);
      }
    }
    for (const key of REMOVED_KEYS) {
      if (key in raw) {
        looseDelete.delete(key);
        console.log(`[settings] removed legacy field "${key}"`);
      }
    }

    // 首次启动自动生成 HookServer Bearer token：32 字节随机 hex = 64 字符（256-bit）。
    // 足以抵御本地暴力枚举；持久化后保持稳定，避免已注入的 hook 命令因 token 变动失效。
    // 阈值 64 与生成长度对齐 —— 之前写 32 是 16 字节 hex 时代的残留，
    // 32-63 字符的弱 token 也能蒙混过关，等于半截 token（128-bit）合规化。
    const tokenRaw = store.get('hookServerToken') as unknown;
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!token || token.length < 64) {
      const fresh = randomBytes(32).toString('hex');
      store.set('hookServerToken', fresh);
      console.log('[settings] generated new hookServerToken (random 32-byte hex = 64 chars)');
    }
    // R2 / B'0 ADR §5.2：MCP HTTP / stdio transport Bearer token 同模式生成。
    // 与 hookServerToken 独立 —— hook token 嵌进每个 CLI 子进程 spawn 命令泄漏面广，
    // mcp token 仅嵌进 codex `~/.codex/config.toml` mcp_servers 段 + Settings UI 显示
    // 给用户复制（外部 MCP client 用），泄漏面窄。一旦 hook token 泄漏，MCP 通道仍安全。
    const mcpTokenRaw = store.get('mcpServerToken') as unknown;
    const mcpToken = typeof mcpTokenRaw === 'string' ? mcpTokenRaw : '';
    if (!mcpToken || mcpToken.length < 64) {
      const fresh = randomBytes(32).toString('hex');
      store.set('mcpServerToken', fresh);
      console.log('[settings] generated new mcpServerToken (random 32-byte hex = 64 chars)');
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

