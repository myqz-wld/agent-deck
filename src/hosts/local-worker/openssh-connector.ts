import { spawn } from 'node:child_process';

import {
  encodeWorkerWireMessage,
  workerAttachedRouteLimits,
  WorkerWireDecoder,
  WorkerWireError,
  type WorkerAttachRequest,
  type WorkerAttached,
} from '@protocol/relay';
import {
  assertRelayRouteFrame,
  type RelayRouteFrame,
  type RelayRouteFrameLimits,
} from '@protocol/relay';
import {
  WorkerAttachmentConnectError,
  WorkerAttachmentRetirementError,
  type WorkerAttachmentConnector,
  type WorkerAttachmentSession,
  type WorkerAttachmentSessionHandlers,
} from './attachment-types';
import {
  assertLocalWorkerSshConfig,
  buildLocalWorkerSshArgv,
  type LocalWorkerSshConfig,
} from './config';
import { OpenSshChildRetirement } from './openssh-retirement';

export interface OpenSshConnectorOptions {
  handshakeTimeoutMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  maxWireBytes?: number;
  maxPendingFrames?: number;
}

export type OpenSshSpawn = typeof spawn;

const WORKER_ROUTE_ENVELOPE_BYTES = 9;

function boundedOption(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function aggregateFailure(reason: Error, cleanup: unknown): WorkerAttachmentRetirementError {
  return new WorkerAttachmentRetirementError(reason, cleanup);
}

export class OpenSshWorkerConnector implements WorkerAttachmentConnector {
  private readonly handshakeTimeoutMs: number;
  private readonly terminateGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxWireBytes: number;
  private readonly maxPendingFrames: number;

  constructor(
    options: OpenSshConnectorOptions = {},
    private readonly spawnProcess: OpenSshSpawn = spawn,
  ) {
    this.handshakeTimeoutMs = boundedOption(
      options.handshakeTimeoutMs ?? 15_000,
      'handshakeTimeoutMs',
      1,
      600_000,
    );
    this.terminateGraceMs = boundedOption(
      options.terminateGraceMs ?? 1_000,
      'terminateGraceMs',
      1,
      600_000,
    );
    this.killGraceMs = boundedOption(
      options.killGraceMs ?? 1_000,
      'killGraceMs',
      1,
      600_000,
    );
    this.maxWireBytes = boundedOption(
      options.maxWireBytes ?? 8 * 1024 * 1024,
      'maxWireBytes',
      1024,
      64 * 1024 * 1024,
    );
    this.maxPendingFrames = boundedOption(
      options.maxPendingFrames ?? 32,
      'maxPendingFrames',
      1,
      4096,
    );
  }

  connect(
    config: LocalWorkerSshConfig,
    request: WorkerAttachRequest,
  ): Promise<WorkerAttachmentSession> {
    assertLocalWorkerSshConfig(config);
    const maxWireBytes = this.maxWireBytes;
    let attachBytes: Uint8Array;
    try {
      attachBytes = encodeWorkerWireMessage(request);
      if (attachBytes.byteLength > this.maxWireBytes) {
        throw new WorkerWireError('Worker attach exceeds maxWireBytes');
      }
      const validated = new WorkerWireDecoder(this.maxWireBytes - 4).push(attachBytes);
      if (validated.length !== 1 || validated[0].type !== 'attach') {
        throw new WorkerWireError('Worker attach request is invalid');
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(config.sshBinary, buildLocalWorkerSshArgv(config), {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C',
        },
      });
      const retirement = new OpenSshChildRetirement(
        child,
        this.terminateGraceMs,
        this.killGraceMs,
      );
      const decoder = new WorkerWireDecoder(this.maxWireBytes - 4, {
        maxFrameBytes: this.maxWireBytes - WORKER_ROUTE_ENVELOPE_BYTES,
      });
      const pendingFrames: RelayRouteFrame[] = [];
      let pendingFrameBytes = 0;
      let handlers: WorkerAttachmentSessionHandlers | null = null;
      let negotiatedLimits: RelayRouteFrameLimits | null = null;
      let handshakeDone = false;
      let closed = false;
      let writeBlocked = false;
      let terminalError: Error | null = null;
      let closeNotificationDelivered = false;
      let stderr = '';
      let timer: ReturnType<typeof setTimeout> | null = null;

      const clearHandshakeTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
      };

      const isolate = (): Promise<void> => {
        if (!closed) {
          closed = true;
          writeBlocked = true;
          clearHandshakeTimer();
        }
        return retirement.retire();
      };

      const notifyTransportFailure = (error: Error): void => {
        terminalError = error;
        if (handlers === null || closeNotificationDelivered) return;
        closeNotificationDelivered = true;
        try {
          handlers.onClose(error);
        } catch (handlerError) {
          terminalError = aggregateFailure(error, handlerError);
        }
      };

      const rejectAfterRetirement = (error: Error): void => {
        if (handshakeDone) return;
        handshakeDone = true;
        terminalError = error;
        const cleanup = isolate();
        void cleanup.then(
          () => reject(error),
          (cleanupError) => reject(aggregateFailure(error, cleanupError)),
        );
      };

      const failTransport = (error: Error): void => {
        if (closed) return;
        terminalError = error;
        if (!handshakeDone) {
          rejectAfterRetirement(error);
          return;
        }
        const cleanup = isolate();
        void cleanup.then(
          () => notifyTransportFailure(error),
          (cleanupError) => {
            const failure = aggregateFailure(error, cleanupError);
            notifyTransportFailure(failure);
          },
        );
      };

      const sessionFor = (attached: WorkerAttached): WorkerAttachmentSession => ({
        attached,
        setHandlers(nextHandlers) {
          if (handlers !== null) throw new Error('Worker attachment handlers are already set');
          handlers = nextHandlers;
          if (closed) {
            notifyTransportFailure(terminalError ?? new Error('OpenSSH attachment is closed'));
            return;
          }
          try {
            for (const frame of pendingFrames.splice(0)) nextHandlers.onFrame(frame);
            pendingFrameBytes = 0;
          } catch (error) {
            const failure = error instanceof Error ? error : new Error('Worker handler failed');
            failTransport(failure);
            throw failure;
          }
        },
        send(frame) {
          if (closed || child.stdin.destroyed) throw new Error('Worker attachment is closed');
          if (writeBlocked) throw new Error('Worker attachment transport is backpressured');
          if (negotiatedLimits === null) throw new Error('Worker route limits are not negotiated');
          assertRelayRouteFrame(frame, negotiatedLimits);
          const encoded = encodeWorkerWireMessage({ type: 'route', frame }, negotiatedLimits);
          if (encoded.byteLength > maxWireBytes) {
            throw new Error('Worker attachment frame exceeds transport limit');
          }
          if (!child.stdin.write(encoded)) writeBlocked = true;
        },
        close: () => isolate(),
      });

      try {
        child.stdin.on('drain', () => {
          if (!closed) writeBlocked = false;
        });
        child.stdin.on('error', (error) => failTransport(error));
        child.stdout.on('data', (chunk: Buffer) => {
          if (closed) return;
          try {
            for (const message of decoder.push(chunk)) {
              if (!handshakeDone) {
                if (message.type === 'rejected') {
                  rejectAfterRetirement(new WorkerAttachmentConnectError(message));
                  return;
                }
                if (message.type !== 'attached') {
                  throw new Error('Relay must answer attach before sending route frames');
                }
                if (
                  message.maxFrameBytes >
                  this.maxWireBytes - WORKER_ROUTE_ENVELOPE_BYTES
                ) {
                  throw new Error('Relay negotiated maxFrameBytes exceeds maxWireBytes');
                }
                negotiatedLimits = workerAttachedRouteLimits(message);
                decoder.setRouteLimits(negotiatedLimits);
                handshakeDone = true;
                clearHandshakeTimer();
                resolve(sessionFor(message));
                continue;
              }
              if (message.type !== 'route' || negotiatedLimits === null) {
                throw new Error('Unexpected Worker attachment control message after registration');
              }
              assertRelayRouteFrame(message.frame, negotiatedLimits);
              if (handlers) handlers.onFrame(message.frame);
              else {
                const pendingBytes = encodeWorkerWireMessage(
                  message,
                  negotiatedLimits,
                ).byteLength;
                if (
                  pendingFrames.length >= this.maxPendingFrames ||
                  pendingFrameBytes + pendingBytes > this.maxWireBytes
                ) {
                  throw new Error('Worker attachment pending frame limit exceeded');
                }
                pendingFrames.push(message.frame);
                pendingFrameBytes += pendingBytes;
              }
            }
          } catch (error) {
            failTransport(error instanceof Error ? error : new Error('Worker wire decode failed'));
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (!closed && stderr.length < 4096) {
            stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
          }
        });
        child.on('error', (error) => {
          if (child.pid === undefined) retirement.markUnavailable();
          failTransport(error);
        });
        child.on('exit', (code, signal) => {
          const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : '';
          failTransport(
            new Error(
              `OpenSSH Worker attachment exited (${signal ?? String(code ?? 'unknown')})${suffix}`,
            ),
          );
        });
        timer = setTimeout(() => {
          rejectAfterRetirement(new Error('OpenSSH Worker attachment handshake timed out'));
        }, this.handshakeTimeoutMs);
        if (!child.stdin.write(attachBytes)) writeBlocked = true;
      } catch (error) {
        failTransport(error instanceof Error ? error : new Error('Failed to write Worker attach'));
      }
    });
  }
}
