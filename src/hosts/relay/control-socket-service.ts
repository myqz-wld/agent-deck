import type { Duplex } from 'node:stream';

import type { RelayControlHost } from './control-host';

export interface RelayControlListener {
  start(
    onConnection: (stream: Duplex) => void,
    onFailure?: (error: Error) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

/** Binds the Relay router to one private Unix listener; public TCP fallback is not supported. */
export class RelayControlSocketService {
  private started = false;
  private failureValue: Error | null = null;

  constructor(
    readonly host: RelayControlHost,
    private readonly listener: RelayControlListener,
  ) {}

  get failure(): Error | null {
    return this.failureValue;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.failureValue = null;
    this.host.start();
    try {
      await this.listener.start(
        (stream) => {
          try {
            this.host.accept(stream);
          } catch {
            stream.destroy();
          }
        },
        (error) => {
          this.failureValue ??= error;
        },
      );
      this.started = true;
    } catch (error) {
      this.host.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      this.host.stop();
      return;
    }
    this.started = false;
    const failures: unknown[] = [];
    try {
      await this.listener.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.host.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Relay control socket shutdown failed');
    }
  }
}
