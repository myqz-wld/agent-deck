import type { CodexAppServerNotification } from './protocol';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Extra roots belong to the whole client process, including native child threads. */
export class CodexComponentConsumers {
  private generation = -1;
  private readonly states = new Map<string, string>();
  observe(notification: CodexAppServerNotification, generation: number): void {
    this.resetGeneration(generation);
    const params = record(notification.params);
    if (notification.method === 'thread/status/changed' && typeof params.threadId === 'string') {
      this.states.set(params.threadId, String(record(params.status).type ?? 'unknown'));
    }
    const item = record(params.item);
    if (item.type !== 'collabAgentToolCall') return;
    const states = record(item.agentsStates);
    for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
      if (typeof id === 'string') this.states.set(id, String(record(states[id]).status ?? 'unknown'));
    }
    for (const [id, state] of Object.entries(states)) this.states.set(id, String(record(state).status ?? 'unknown'));
  }
  busy(generation: number): boolean {
    this.resetGeneration(generation);
    return [...this.states.values()].some(status => !['idle', 'notLoaded', 'completed', 'errored', 'shutdown', 'notFound'].includes(status));
  }
  private resetGeneration(generation: number): void {
    if (this.generation !== generation) { this.states.clear(); this.generation = generation; }
  }
}
