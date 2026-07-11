export interface HandOffCutoverLease {
  readonly sourceSessionId: string;
  release(): void;
}

/**
 * Process-wide exclusion for the only handoff phase that may create a successor or move source
 * ownership. Tokens prevent a stale/idempotent release from unlocking a newer handoff.
 */
export class HandOffCutoverCoordinator {
  private readonly active = new Map<string, symbol>();

  tryAcquire(sourceSessionId: string): HandOffCutoverLease | null {
    if (this.active.has(sourceSessionId)) return null;
    const token = Symbol(sourceSessionId);
    this.active.set(sourceSessionId, token);
    let released = false;
    return {
      sourceSessionId,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(sourceSessionId) === token) this.active.delete(sourceSessionId);
      },
    };
  }

  isActive(sourceSessionId: string): boolean {
    return this.active.has(sourceSessionId);
  }
}

/** Shared by the UI coordinator and the one-step MCP handoff handler. */
export const handOffCutoverCoordinator = new HandOffCutoverCoordinator();
