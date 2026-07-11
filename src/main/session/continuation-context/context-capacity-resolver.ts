import type { SessionAdapterId } from '@shared/types/session';

export const DEFAULT_UNSEEN_MODEL_CONTEXT_WINDOW_TOKENS = 128_000;

export interface ResolvedContextWindow {
  contextWindowTokens: number;
  source: 'observed' | 'fallback';
}

function capacityKey(adapter: SessionAdapterId, model: string | null): string {
  return `${adapter}\u0000${model?.trim() || '<default>'}`;
}

export class ContextCapacityResolver {
  private readonly observations = new Map<string, number>();

  observe(adapter: SessionAdapterId, model: string | null, contextWindowTokens: number): void {
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) return;
    const key = capacityKey(adapter, model);
    const current = this.observations.get(key);
    // Keep the most conservative trusted observation for a concrete runtime fingerprint.
    this.observations.set(key, current === undefined ? contextWindowTokens : Math.min(current, contextWindowTokens));
  }

  resolve(adapter: SessionAdapterId, model: string | null): ResolvedContextWindow {
    const observed = this.observations.get(capacityKey(adapter, model));
    return observed === undefined
      ? {
          contextWindowTokens: DEFAULT_UNSEEN_MODEL_CONTEXT_WINDOW_TOKENS,
          source: 'fallback',
        }
      : { contextWindowTokens: observed, source: 'observed' };
  }

  clear(): void {
    this.observations.clear();
  }
}

export const contextCapacityResolver = new ContextCapacityResolver();
