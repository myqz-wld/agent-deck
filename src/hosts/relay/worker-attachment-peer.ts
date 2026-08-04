import {
  encodeWorkerWireMessage,
  WorkerWireDecoder,
  type WorkerAttachRejected,
  type WorkerWireMessage,
} from '@protocol/relay';
import type { RelayStreamRouter } from './router';

export type RelayWorkerPeerState = 'awaiting-attach' | 'attached' | 'rejected' | 'closed';

export interface AuthenticatedRelayWorker {
  instanceId: string;
  workerId: string;
  credentialId: string;
}

/**
 * Restricted forced-command stdio peer. The caller owns SSH authentication and writes returned
 * chunks to stdout; this peer owns no listener, shell, Core service, or business persistence.
 */
export class RelayWorkerAttachmentPeer {
  private readonly decoder: WorkerWireDecoder;
  private stateValue: RelayWorkerPeerState = 'awaiting-attach';

  constructor(
    private readonly router: RelayStreamRouter,
    readonly connectionId: string,
    private readonly authenticatedWorker: AuthenticatedRelayWorker,
    maxWireBytes = 8 * 1024 * 1024,
  ) {
    if (authenticatedWorker.instanceId !== router.instanceId) {
      throw new Error('Authenticated Worker instance does not match the Relay router');
    }
    this.decoder = new WorkerWireDecoder(maxWireBytes, {
      maxFrameBytes: router.limits.maxFrameBytes,
      maxCreditBytes: router.limits.maxCreditBytes,
    });
  }

  state(): RelayWorkerPeerState {
    return this.stateValue;
  }

  push(chunk: Uint8Array, now = Date.now()): Uint8Array[] {
    if (this.stateValue === 'closed' || this.stateValue === 'rejected') {
      throw new Error('Worker attachment peer is not active');
    }
    const output: Uint8Array[] = [];
    for (const message of this.decoder.push(chunk)) {
      this.acceptMessage(message, output, now);
    }
    return output;
  }

  private acceptMessage(message: WorkerWireMessage, output: Uint8Array[], now: number): void {
    if (this.stateValue === 'awaiting-attach') {
      if (message.type !== 'attach') throw new Error('First Worker wire message must be attach');
      const credential = this.router.metadata.credential(this.authenticatedWorker.credentialId);
      if (
        message.instanceId !== this.authenticatedWorker.instanceId ||
        message.workerId !== this.authenticatedWorker.workerId ||
        message.credentialId !== this.authenticatedWorker.credentialId ||
        credential === null ||
        credential.instanceId !== this.authenticatedWorker.instanceId ||
        credential.kind !== 'relay-worker' ||
        credential.status !== 'active'
      ) {
        const rejected: WorkerAttachRejected = {
          type: 'rejected',
          code: 'credential_mismatch',
          message: 'Worker attach identity does not match the authenticated SSH credential',
          retryable: false,
          currentGeneration: this.router.status().generation || null,
        };
        this.stateValue = 'rejected';
        output.push(encodeWorkerWireMessage(rejected));
        return;
      }
      const result = this.router.attachWorker(message, this.connectionId, now);
      if (result.accepted) {
        this.stateValue = 'attached';
        output.push(encodeWorkerWireMessage(result.attached));
      } else {
        this.stateValue = 'rejected';
        output.push(encodeWorkerWireMessage(result.rejected));
      }
      return;
    }
    if (message.type !== 'route') {
      throw new Error('Attached Worker may send route frames only');
    }
    this.router.routeFromWorker(this.connectionId, message.frame, now);
  }

  drain(maxBytes = Number.MAX_SAFE_INTEGER): Uint8Array[] {
    if (this.stateValue !== 'attached') return [];
    const delivery = this.router.drainWorkerFor(this.connectionId, maxBytes);
    if (!delivery) return [];
    return delivery.frames.map((frame) =>
      encodeWorkerWireMessage(
        { type: 'route', frame },
        {
          maxFrameBytes: this.router.limits.maxFrameBytes,
          maxCreditBytes: this.router.limits.maxCreditBytes,
        },
      ),
    );
  }

  close(now = Date.now()): void {
    if (this.stateValue === 'closed') return;
    const wasAttached = this.stateValue === 'attached';
    this.stateValue = 'closed';
    if (wasAttached) this.router.detachWorker(this.connectionId, now);
  }
}
