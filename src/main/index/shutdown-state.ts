let shutdownBegun = false;

/** Close DB-backed ingress before any asynchronous quit drain begins. Idempotent for re-entry. */
export function beginAppShutdown(): void {
  shutdownBegun = true;
}

export function hasAppShutdownBegun(): boolean {
  return shutdownBegun;
}

export function resetAppShutdownForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetAppShutdownForTests is test-only');
  }
  shutdownBegun = false;
}
