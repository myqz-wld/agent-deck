import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

import {
  AgentDeckClientErrorCode,
  issueRemoteOwnerAccessContext,
  type ClientHello,
} from '@contracts/index';
import {
  BridgeAdmissionDecoder,
  type BridgeClientAdmission,
  type DecodedBridgeAdmission,
} from '@protocol/index';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';

import type { DaemonHost } from './host';
import { DaemonRequestError, type DaemonListener } from './types';

export type DaemonBridgeAuthorizer = (
  admission: BridgeClientAdmission,
) => Promise<boolean> | boolean;

export interface DaemonSshBridgeListenerOptions {
  readonly instanceId: string;
  readonly host: DaemonHost;
  readonly listener: DaemonListener;
  readonly authorize: DaemonBridgeAuthorizer;
  readonly admissionTimeoutMs?: number;
  readonly maxAdmissionBytes?: number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new Error('Bridge admission received non-byte data');
}

/**
 * Authenticates the provisioning-owned admission header before handing the remaining byte stream
 * to the ordinary daemon protocol. The header is out-of-band from renderer/client-controlled data.
 */
export class DaemonSshBridgeListener {
  private readonly admissionTimeoutMs: number;
  private readonly maxAdmissionBytes: number;
  private readonly pending = new Set<Duplex>();
  private started = false;
  private failureValue: Error | null = null;

  constructor(private readonly options: DaemonSshBridgeListenerOptions) {
    this.admissionTimeoutMs = positiveInteger(
      options.admissionTimeoutMs ?? 10_000,
      'admissionTimeoutMs',
    );
    this.maxAdmissionBytes = positiveInteger(
      options.maxAdmissionBytes ?? 8 * 1024,
      'maxAdmissionBytes',
    );
  }

  get failure(): Error | null {
    return this.failureValue;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.failureValue = null;
    try {
      await this.options.listener.start(
        (stream) => this.acceptRawStream(stream),
        (error) => {
          this.failureValue ??= error;
        },
      );
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const stream of this.pending) stream.destroy();
    this.pending.clear();
    await this.options.listener.stop();
  }

  private acceptRawStream(stream: Duplex): void {
    if (!this.started) {
      stream.destroy();
      return;
    }
    this.pending.add(stream);
    const decoder = new BridgeAdmissionDecoder(this.maxAdmissionBytes);
    let terminal = false;
    const timeout = setTimeout(() => fail(), this.admissionTimeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('end', fail);
      stream.off('error', fail);
      this.pending.delete(stream);
    };
    const fail = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      stream.destroy();
    };
    const onData = (chunk: unknown): void => {
      if (terminal) return;
      let decoded: DecodedBridgeAdmission | null;
      try {
        decoded = decoder.push(asBytes(chunk));
      } catch {
        fail();
        return;
      }
      if (!decoded) return;
      terminal = true;
      stream.pause();
      cleanup();
      this.handoff(stream, decoded);
    };

    stream.on('data', onData);
    stream.once('end', fail);
    stream.once('error', fail);
  }

  private handoff(stream: Duplex, decoded: DecodedBridgeAdmission): void {
    const admission = decoded.admission;
    if (
      !this.started ||
      admission.role !== 'client' ||
      admission.topology !== 'full' ||
      admission.instanceId !== this.options.instanceId
    ) {
      stream.destroy();
      return;
    }
    try {
      this.options.host.accept({
        stream,
        label: `${admission.surface}:${admission.credentialId}`,
        credential: {
          credentialId: admission.credentialId,
          surface: admission.surface,
        },
        createAccessContext: (hello) => this.createAccess(admission, hello),
      });
      if (decoded.remainder.byteLength > 0) {
        stream.unshift(Buffer.from(decoded.remainder));
      }
      stream.resume();
    } catch {
      stream.destroy();
    }
  }

  private async createAccess(
    admission: BridgeClientAdmission,
    hello: ClientHello,
  ) {
    if (admission.connectionScope !== deriveConnectionScope(
      admission.instanceId,
      admission.credentialId,
    )) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Revoked,
        'SSH connection scope does not match its credential',
      );
    }
    if (!(await this.options.authorize(admission))) {
      throw new DaemonRequestError(
        AgentDeckClientErrorCode.Revoked,
        'SSH access credential is not active',
      );
    }
    return issueRemoteOwnerAccessContext({
      topology: 'full',
      instanceId: this.options.instanceId,
      clientId: hello.clientId,
      connectionScope: admission.connectionScope,
      surface: admission.surface,
    });
  }
}
