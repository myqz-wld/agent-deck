import type { WorkerAttachRejected } from '@protocol/relay';
import { RelayMetadataStore, type CredentialMetadata } from './metadata';

interface ActiveWorkerStatus {
  online: boolean;
  connectionId: string | null;
}

interface ClientCredentialRegistration {
  clientId: string;
  credentialId: string;
  surface: 'desktop-full' | 'feishu-session-console';
}

export class RelayCredentialPolicy {
  constructor(
    private readonly metadata: RelayMetadataStore,
    private readonly instanceId: string,
  ) {}

  private active(
    credentialId: string | null,
    kinds: readonly CredentialMetadata['kind'][],
  ): boolean {
    if (credentialId === null) return false;
    const credential = this.metadata.credential(credentialId);
    return (
      credential !== null &&
      credential.instanceId === this.instanceId &&
      credential.status === 'active' &&
      kinds.includes(credential.kind)
    );
  }

  activeWorker(credentialId: string | null): boolean {
    return this.active(credentialId, ['relay-worker']);
  }

  activeClient(credentialId: string): boolean {
    return this.active(credentialId, ['ssh-client', 'feishu']);
  }

  activeClientSurface(
    credentialId: string,
    surface: 'desktop-full' | 'feishu-session-console',
  ): boolean {
    return this.active(
      credentialId,
      [surface === 'desktop-full' ? 'ssh-client' : 'feishu'],
    );
  }

  targetsWorker(
    status: ActiveWorkerStatus,
    connectionId: string | null,
  ): status is ActiveWorkerStatus & { connectionId: string } {
    return (
      status.online &&
      status.connectionId !== null &&
      (connectionId === null || status.connectionId === connectionId)
    );
  }

  disconnectInactiveClients(
    clients: Iterable<ClientCredentialRegistration>,
    disconnect: (clientId: string) => void,
  ): void {
    for (const client of clients) {
      if (!this.activeClientSurface(client.credentialId, client.surface)) {
        disconnect(client.clientId);
      }
    }
  }

  rejectWorker(currentGeneration: number): WorkerAttachRejected {
    return {
      type: 'rejected',
      code: 'credential_mismatch',
      message: 'Worker credential is not active for this Relay instance',
      retryable: false,
      currentGeneration: currentGeneration || null,
    };
  }
}
