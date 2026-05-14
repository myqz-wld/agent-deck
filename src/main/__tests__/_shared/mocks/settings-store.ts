/**
 * 测试用 settingsStore mock factory（R37 P2-F Step 3.1）。
 *
 * 4 个 test 文件（agent-deck-mcp/tools / spawn-guards / universal-message-watcher /
 * sdk-bridge.recovery）都 mock `@main/store/settings-store`，但每个 test 只用 `get` /
 * `getAll` 子集。Factory 接受可选 `initial` Map 让 caller 注入预设值，未命中 key 走 fallback
 * 函数（默认 `() => undefined`）。
 *
 * **三种典型用法**：
 * 1. 全 noop（caller 不读 settings）：`makeSettingsStoreMock()`
 * 2. 单 key 预设：`makeSettingsStoreMock({ initial: { mcpMaxSpawnDepth: 3 } })`
 * 3. 全 key fallback：`makeSettingsStoreMock({ get: (key) => key === 'foo' ? 1 : undefined })`
 */

import { vi } from 'vitest';

export interface SettingsStoreMockOptions {
  /** 预设 key → value（getAll 也返回这些 + initial 字段） */
  initial?: Record<string, unknown>;
  /** 自定 get(key) 实现（优先于 initial）— 复杂场景用 */
  get?: (key: string) => unknown;
  /** 部分覆盖（如 set / patch） */
  overrides?: Record<string, unknown>;
}

export type SettingsStoreMock = Record<string, unknown> & {
  /** caller 直接改这个 Map 让后续 get(key) 命中（mockState 模式） */
  __initial: Record<string, unknown>;
};

export function makeSettingsStoreMock(opts: SettingsStoreMockOptions = {}): SettingsStoreMock {
  const initial: Record<string, unknown> = opts.initial ? { ...opts.initial } : {};
  const customGet = opts.get;

  const base = {
    get: (key: string) => {
      if (customGet) return customGet(key);
      return initial[key];
    },
    getAll: () => ({ ...initial }),
    set: vi.fn(),
    patch: vi.fn(),
  };

  return Object.assign(base, opts.overrides ?? {}, { __initial: initial });
}
