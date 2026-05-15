import type { AgentAdapter, AdapterContext } from './types';
import type { ClaudeCodeAdapter } from './claude-code';
import type { CodexCliAdapter } from './codex-cli';
import type { AiderAdapter } from './aider';
import type { GenericPtyAdapter } from './generic-pty';

/**
 * D2 typed adapter id 映射：agentId → 具体 adapter class type。
 *
 * **典型用法**：caller 编译期知道具体 adapter id 时直接 import typed instance（
 * `import { claudeCodeAdapter } from './adapters/claude-code'`）拿到 ClaudeCodeAdapter
 * 类型,自动暴露 adapter-专属方法（如 respondPermission / restartWithClaudeCodeSandbox）。
 *
 * **dynamic dispatch caller**（如 5 处生产 caller / IPC handler / cli.ts）走
 * `adapterRegistry.get(string)` 拿 AgentAdapter union 兜底（generic createSession 即可）;
 * typed overload **不加到 registry.get**,因为 enum union arg 让 TS 走 typed overload
 * 后 return adapter union 调 createSession(opts) 会撞 union dispatch fail（opts 必须
 * assignable to 每个 arm createSession opts type,而 narrow opts 单 arm 不满足）。
 *
 * 加新 adapter 时三步：(1) types.ts 加 union arm; (2) options-builder.ts switch 加 case;
 * (3) 本 map 加映射 + index.ts 加 register。漏 (1)/(2) TS 编译期报错;漏 (3) 运行时
 * register 时报 "already registered" 假阳但 caller 仍能用 string overload 拿。
 */
export type AdapterIdMap = {
  'claude-code': ClaudeCodeAdapter;
  'codex-cli': CodexCliAdapter;
  'aider': AiderAdapter;
  'generic-pty': GenericPtyAdapter;
};

class AdapterRegistryClass {
  private map = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.map.has(adapter.id)) {
      throw new Error(`Adapter ${adapter.id} already registered`);
    }
    this.map.set(adapter.id, adapter);
  }

  /**
   * 仅 string overload：返回 AgentAdapter union 兜底。
   *
   * 不加 typed overload `<T extends keyof AdapterIdMap>(id: T): AdapterIdMap[T] | undefined`,
   * 因为 enum union arg（如 SpawnSessionArgs.adapter）让 TS 推走 typed overload 后
   * return adapter union → caller 调 `adapter.createSession(opts)` 撞 union dispatch
   * fail（opts narrow 到 single arm 不 assignable to union 每个 arm）。
   *
   * caller 想拿 typed adapter instance → 直接 `import { claudeCodeAdapter }` 走 typed
   * export（绕过 registry）。registry 是 dynamic dispatch 兜底通道。
   */
  get(id: string): AgentAdapter | undefined {
    return this.map.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.map.values()];
  }

  async initAll(ctx: AdapterContext): Promise<void> {
    for (const adapter of this.map.values()) {
      try {
        await adapter.init(ctx);
        console.log(`[adapter] ${adapter.id} initialized`);
      } catch (err) {
        console.error(`[adapter] ${adapter.id} init failed:`, err);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const adapter of this.map.values()) {
      try {
        await adapter.shutdown();
      } catch (err) {
        console.error(`[adapter] ${adapter.id} shutdown failed:`, err);
      }
    }
  }
}

export const adapterRegistry = new AdapterRegistryClass();
