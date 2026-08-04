export class ElectronRegistryLifecycleGate {
  private readonly removals = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>();
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  assertMutable(profileId: string | null, action: string): void {
    if (this.stopping) {
      throw new Error(`Electron host registry is stopping; cannot ${action}`);
    }
    if (profileId && this.removing.has(profileId)) {
      throw new Error(`Host profile is being removed; cannot ${action}: ${profileId}`);
    }
  }

  remove(profileId: string, run: () => Promise<void>): Promise<void> {
    const existing = this.removals.get(profileId);
    if (existing) return existing;
    this.assertMutable(profileId, 'remove profile');
    this.removing.add(profileId);
    const promise = run();
    this.removals.set(profileId, promise);
    void promise.then(
      () => {
        this.removals.delete(profileId);
        this.removing.delete(profileId);
      },
      () => undefined,
    );
    return promise;
  }

  stop(run: () => Promise<void>): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = run();
    return this.stopPromise;
  }
}
