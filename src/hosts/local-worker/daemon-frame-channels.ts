import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';

import {
  DeploymentTopology,
  type AuthenticatedClientAccessContext,
  type ClientHello,
} from '@contracts/index';
import { DaemonProtocolConnection, type DaemonCoreRuntime } from '@hosts/daemon';
import type { RelayResetCode } from '@protocol/relay';

import type {
  CoreFrameAccessContext,
  CoreFrameChannel,
  CoreFrameChannelFactory,
  CoreFrameOutput,
} from './frame-bridge';

export interface LocalWorkerDaemonFrameChannelOptions {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly authoritativeCoreId: string;
  readonly runtime: DaemonCoreRuntime;
  readonly getWorkerGeneration: () => number;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error('Relay daemon stream failed');
}

class RelayDaemonStream extends Duplex {
  private terminal = false;
  private suppressOutputTerminal = false;
  private inputClosed = false;

  constructor(private readonly output: CoreFrameOutput) {
    super({ readableHighWaterMark: 4 * 1024 * 1024 });
  }

  _read(): void {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.terminal) {
      callback(new Error('Relay daemon stream is closed'));
      return;
    }
    try {
      this.output.data(Buffer.from(chunk));
      callback();
    } catch (error) {
      callback(errorValue(error));
    }
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.terminal) {
      this.terminal = true;
      if (!this.suppressOutputTerminal) {
        try {
          if (error) this.output.reset('protocol_error');
          else this.output.close();
        } catch {
          // The frame bridge already owns terminal containment for this stream.
        }
      }
    }
    callback(error);
  }

  accept(payload: Uint8Array): boolean {
    if (this.terminal || this.inputClosed || payload.byteLength === 0) return false;
    return this.push(Buffer.from(payload));
  }

  closeInput(): void {
    if (this.terminal || this.inputClosed) return;
    this.inputClosed = true;
    this.push(null);
  }

  resetFromRelay(): void {
    if (this.terminal) return;
    this.suppressOutputTerminal = true;
    this.destroy();
  }
}

function accessContext(
  instanceId: string,
  hello: ClientHello,
  access: CoreFrameAccessContext,
): AuthenticatedClientAccessContext {
  const common = {
    kind: 'authenticated-client' as const,
    topology: DeploymentTopology.Relay,
    instanceId,
    clientId: hello.clientId,
    accessCredentialId: access.accessCredentialId,
    authority: 'owner-equivalent' as const,
  };
  return access.surface === 'desktop-full'
    ? { ...common, transport: 'ssh', surface: 'desktop-full' }
    : { ...common, transport: 'feishu', surface: 'feishu-session-console' };
}

export function createLocalWorkerDaemonFrameChannels(
  options: LocalWorkerDaemonFrameChannelOptions,
): CoreFrameChannelFactory {
  return Object.freeze({
    open(
      streamId: string,
      output: CoreFrameOutput,
      access: CoreFrameAccessContext,
    ): CoreFrameChannel {
      const stream = new RelayDaemonStream(output);
      new DaemonProtocolConnection({
        instanceId: options.instanceId,
        appVersion: options.appVersion,
        authoritativeCoreId: options.authoritativeCoreId,
        authoritativeCoreGeneration: options.getWorkerGeneration(),
        topology: DeploymentTopology.Relay,
        runtime: options.runtime,
        admission: {
          stream,
          label: `relay:${streamId}`,
          createAccessContext: (hello) => accessContext(options.instanceId, hello, access),
        },
        assertCredentialActive: async () => undefined,
        onAuthenticated: () => undefined,
      });
      return Object.freeze({
        write: (payload: Uint8Array) => stream.accept(payload),
        closeInput: () => stream.closeInput(),
        reset: (_code: RelayResetCode) => stream.resetFromRelay(),
      });
    },
  });
}
