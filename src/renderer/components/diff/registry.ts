import type { DiffPayload } from '@shared/types';
import type { DiffRendererPlugin } from './types';

class DiffRegistryClass {
  private plugins: DiffRendererPlugin[] = [];

  register<T>(plugin: DiffRendererPlugin<T>): void {
    this.plugins.push(plugin as DiffRendererPlugin);
    this.plugins.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  resolve(payload: DiffPayload): DiffRendererPlugin | null {
    return this.plugins.find((p) => p.canHandle(payload)) ?? null;
  }

  list(): DiffRendererPlugin[] {
    return [...this.plugins];
  }
}

export const diffRegistry = new DiffRegistryClass();
