import type { Duplex } from 'node:stream';

import { DaemonProtocolConnection } from './connection';
import type { DaemonInstancePaths } from './instance-paths';
import { preflightNodeNativeSqlite } from './sqlite-preflight';
import type {
  DaemonAccessContextFactory,
  DaemonConnectionAdmission,
  DaemonConnectionLimits,
  DaemonCoreRuntime,
  DaemonListener,
} from './types';
import { UnixSocketDaemonListener } from './unix-socket-listener';

export type DaemonHostState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface DaemonHostOptions {
  readonly paths: DaemonInstancePaths;
  readonly appVersion: string;
  readonly runtime: DaemonCoreRuntime;
  readonly authoritativeCoreId?: string;
  readonly listener?: DaemonListener | null;
  readonly defaultAccessContextFactory?: DaemonAccessContextFactory;
  readonly connectionLimits?: Partial<DaemonConnectionLimits>;
  readonly sqlitePreflight?: () => unknown | Promise<unknown>;
  readonly now?: () => number;
}

/**
 * Node-only Server Core composition host. Transport connections are children of the host; their
 * teardown never calls the injected Core runtime lifecycle.
 */
export class DaemonHost {
  private readonly listener: DaemonListener | null;
  private readonly connections = new Set<DaemonProtocolConnection>();
  private stateValue: DaemonHostState = 'idle';
  private listenerFailureValue: Error | null = null;

  constructor(private readonly options: DaemonHostOptions) {
    this.listener =
      options.listener === undefined
        ? new UnixSocketDaemonListener(options.paths.socketPath, options.paths.runtimeDirectory)
        : options.listener;
  }

  get state(): DaemonHostState {
    return this.stateValue;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get listenerFailure(): Error | null {
    return this.listenerFailureValue;
  }

  async start(): Promise<void> {
    if (this.stateValue === 'running') return;
    if (this.stateValue !== 'idle') {
      throw new Error(`Cannot start daemon host from ${this.stateValue}`);
    }
    if (this.listener && !this.options.defaultAccessContextFactory) {
      throw new Error('A listening daemon requires a transport-created AccessContext factory');
    }

    this.stateValue = 'starting';
    this.listenerFailureValue = null;
    let runtimeStarted = false;
    try {
      await (this.options.sqlitePreflight ?? preflightNodeNativeSqlite)();
      await this.options.runtime.start();
      runtimeStarted = true;
      await this.listener?.start(
        (stream) => this.acceptDefaultStream(stream),
        (error) => {
          this.listenerFailureValue ??= error;
        },
      );
      this.stateValue = 'running';
    } catch (error) {
      this.stateValue = 'stopped';
      await this.shutdownConnections('daemon-start-failed');
      try {
        await this.listener?.stop();
      } catch {
        // Preserve the startup/preflight failure as the primary error.
      }
      if (runtimeStarted) {
        try {
          await this.options.runtime.stop('daemon-start-failed');
        } catch {
          // Preserve the startup/preflight failure as the primary error.
        }
      }
      throw error;
    }
  }

  accept(admission: DaemonConnectionAdmission): DaemonProtocolConnection {
    if (this.stateValue !== 'running') {
      admission.stream.destroy();
      throw new Error(`Cannot accept daemon connection while host is ${this.stateValue}`);
    }
    return this.createConnection(admission);
  }

  private createConnection(admission: DaemonConnectionAdmission): DaemonProtocolConnection {
    const connection = new DaemonProtocolConnection({
      instanceId: this.options.paths.instanceId,
      appVersion: this.options.appVersion,
      authoritativeCoreId:
        this.options.authoritativeCoreId ?? `server-core:${this.options.paths.instanceId}`,
      runtime: this.options.runtime,
      admission,
      limits: this.options.connectionLimits,
      now: this.options.now,
      onClose: (closed) => this.connections.delete(closed),
    });
    this.connections.add(connection);
    return connection;
  }

  async stop(reason = 'daemon-stopped'): Promise<void> {
    if (this.stateValue === 'idle' || this.stateValue === 'stopped') {
      this.stateValue = 'stopped';
      return;
    }
    if (this.stateValue !== 'running') {
      throw new Error(`Cannot stop daemon host from ${this.stateValue}`);
    }
    this.stateValue = 'stopping';
    const failures: unknown[] = [];
    failures.push(...(await this.shutdownConnections(reason)));
    try {
      await this.listener?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.options.runtime.stop(reason);
    } catch (error) {
      failures.push(error);
    }
    this.stateValue = 'stopped';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Daemon host shutdown failed');
    }
  }

  private acceptDefaultStream(stream: Duplex): void {
    const createAccessContext = this.options.defaultAccessContextFactory;
    if (
      !createAccessContext ||
      (this.stateValue !== 'starting' && this.stateValue !== 'running')
    ) {
      stream.destroy();
      return;
    }
    this.createConnection({ stream, createAccessContext, label: 'private-unix-socket' });
  }

  private async shutdownConnections(reason: string): Promise<unknown[]> {
    const connections = [...this.connections];
    const settled = await Promise.allSettled(
      connections.map((connection) => connection.shutdown(reason)),
    );
    return settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
  }
}
