import type { AgentAdapter, AdapterContext } from './types';

class AdapterRegistryClass {
  private map = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.map.has(adapter.id)) {
      throw new Error(`Adapter ${adapter.id} already registered`);
    }
    this.map.set(adapter.id, adapter);
  }

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
