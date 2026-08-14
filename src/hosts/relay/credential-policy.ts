import type { WorkerAttachRejected } from '@protocol/relay';
import {
  assertRemoteOwnerGrantClaim,
  copyRemoteOwnerGrantClaim,
  issueRemoteOwnerGrantClaim,
  type RemoteOwnerGrantClaim,
} from '@contracts/index';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';
import { RelayMetadataStore, type CredentialMetadata } from './metadata';
import type { RelayClientState } from './router-state';
import { RelayRouterError } from './router-types';

interface ActiveWorkerStatus {
  online: boolean;
  connectionId: string | null;
}

export type RelayClientGrantResolver = (
  credentialId: string,
  surface: 'desktop' | 'feishu',
) => RemoteOwnerGrantClaim;

export class RelayCredentialPolicy {
  constructor(
    private readonly metadata: RelayMetadataStore,
    private readonly instanceId: string,
    private readonly resolveClientGrant: RelayClientGrantResolver = (_credentialId, surface) =>
      issueRemoteOwnerGrantClaim(surface),
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
    surface: 'desktop' | 'feishu',
  ): boolean {
    return this.active(
      credentialId,
      [surface === 'desktop' ? 'ssh-client' : 'feishu'],
    );
  }

  createClient(
    clientId: string,
    credentialId: string,
    surface: 'desktop' | 'feishu',
    connectionScope: string | undefined,
    queue: RelayClientState['queue'],
  ): RelayClientState {
    const scope = connectionScope ?? deriveConnectionScope(this.instanceId, credentialId);
    if (clientId.length === 0 || credentialId.length === 0 || scope.length === 0) {
      throw new RelayRouterError(
        'client_unknown',
        'clientId, credentialId, and connectionScope are required',
      );
    }
    if (!this.activeClientSurface(credentialId, surface)) {
      throw new RelayRouterError(
        'credential_invalid',
        'Client credential is not active for this Relay instance',
      );
    }
    return {
      clientId,
      credentialId,
      connectionScope: scope,
      surface,
      grant: this.clientGrant(credentialId, surface),
      queue,
    };
  }

  clientPolicyCurrent(client: RelayClientState): boolean {
    if (!this.activeClientSurface(client.credentialId, client.surface)) return false;
    try {
      return JSON.stringify(this.clientGrant(client.credentialId, client.surface)) ===
        JSON.stringify(client.grant);
    } catch {
      return false;
    }
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
    clients: Iterable<RelayClientState>,
    disconnect: (clientId: string) => void,
  ): void {
    for (const client of clients) {
      if (!this.clientPolicyCurrent(client)) disconnect(client.clientId);
    }
  }

  private clientGrant(
    credentialId: string,
    surface: 'desktop' | 'feishu',
  ): RemoteOwnerGrantClaim {
    try {
      const grant = this.resolveClientGrant(credentialId, surface);
      assertRemoteOwnerGrantClaim(grant);
      return copyRemoteOwnerGrantClaim(grant);
    } catch {
      throw new RelayRouterError('credential_invalid', 'Client access policy is unavailable');
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
