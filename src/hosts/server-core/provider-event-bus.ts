import type { AgentEvent } from '@shared/types';

import type { ServerCorePlanReviewEventPort } from './mcp-plan-review';

/** Process-local provider event fan-out; durable storage remains the authoritative history. */
export class ServerCoreProviderEventBus implements ServerCorePlanReviewEventPort {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
