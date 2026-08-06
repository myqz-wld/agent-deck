import type { RemoteConnectionCredential } from '@shared/remote-host';

import { RemoteHostConnectionSelections } from './connection-selections';
import type {
  InstalledRemoteHostCredential,
  RemoteHostCredentialMaterialStore,
} from './credential-material-store';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';

export function testConnectionCredential(
  overrides: Partial<RemoteConnectionCredential> = {},
): RemoteConnectionCredential {
  return {
    schemaVersion: 1,
    kind: 'agent-deck-remote-connection-credential',
    label: 'Test remote',
    topology: 'server-core',
    instanceId: 'instance-a',
    credentialId: 'desktop-a',
    endpoint: { hostname: 'core.example.test', port: 22, username: 'agentdeck' },
    hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH' }],
    identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
    ...overrides,
  };
}

export function testConnectionSelections(
  createId: () => string,
  resolveCredential: (path: string) => RemoteConnectionCredential = () => testConnectionCredential(),
): RemoteHostConnectionSelections {
  return new RemoteHostConnectionSelections({ createId, readFile: resolveCredential });
}

export class MemoryCredentialMaterialStore implements RemoteHostCredentialMaterialStore {
  private next = 0;
  readonly disposed: InstalledRemoteHostCredential[] = [];

  install(): InstalledRemoteHostCredential {
    this.next += 1;
    return {
      identityFile: `/private/managed/identity-${this.next}.key`,
      knownHostsFile: `/private/managed/known-hosts-${this.next}.txt`,
    };
  }

  dispose(material: InstalledRemoteHostCredential): void {
    this.disposed.push(material);
  }
}
