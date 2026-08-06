import type { ServerCoreRuntimeLifecyclePort } from './runtime-core';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';

export interface ServerCoreProviderRuntimeLifecycleOptions {
  readonly repository: {
    start(): Promise<void>;
    stop(reason: string): Promise<void>;
  };
  readonly metadata: {
    start(): void;
    close(): void;
  };
  readonly initializeProviders: () => Promise<void>;
  readonly retireProviders: () => Promise<void>;
  readonly shutdownProviders: () => Promise<void>;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
}

/** Owns repository, metadata, and provider order for one concrete Server Core runtime. */
export class ServerCoreProviderRuntimeLifecycle implements ServerCoreRuntimeLifecyclePort {
  private state: 'idle' | 'starting' | 'running' | 'closing' | 'closed' = 'idle';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: ServerCoreProviderRuntimeLifecycleOptions) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('provider runtime is closed'));
    this.state = 'starting';
    this.startPromise = this.startOwned();
    return this.startPromise;
  }

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned(reason);
    return this.stopPromise;
  }

  private async startOwned(): Promise<void> {
    let repositoryStarted = false;
    let metadataStarted = false;
    let providersOwned = false;
    try {
      await this.options.repository.start();
      repositoryStarted = true;
      this.options.metadata.start();
      metadataStarted = true;
      providersOwned = true;
      await this.options.initializeProviders();
      this.state = 'running';
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (providersOwned) {
        await this.capture(() => this.options.shutdownProviders(), rollbackFailures);
      }
      if (metadataStarted) this.captureSync(() => this.options.metadata.close(), rollbackFailures);
      if (repositoryStarted) {
        await this.capture(() => this.options.repository.stop('startup-failed'), rollbackFailures);
      }
      this.state = 'closed';
      if (rollbackFailures.length > 0) this.warn('provider startup rollback was incomplete');
      throw error;
    }
  }

  private async stopOwned(reason: string): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.state === 'closed') return;
    if (this.state !== 'running') {
      this.state = 'closed';
      return;
    }
    this.state = 'closing';
    const failures: unknown[] = [];
    await this.capture(() => this.options.retireProviders(), failures);
    await this.capture(() => this.options.shutdownProviders(), failures);
    this.captureSync(() => this.options.metadata.close(), failures);
    await this.capture(() => this.options.repository.stop(reason), failures);
    this.state = 'closed';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Server Core provider cleanup failed');
    }
  }

  private async capture(operation: () => Promise<void>, failures: unknown[]): Promise<void> {
    try { await operation(); } catch (error) { failures.push(error); }
  }

  private captureSync(operation: () => void, failures: unknown[]): void {
    try { operation(); } catch (error) { failures.push(error); }
  }

  private warn(message: string): void {
    try { this.options.diagnostics.warn(message); } catch {}
  }
}
