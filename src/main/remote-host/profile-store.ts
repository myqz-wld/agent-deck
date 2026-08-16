import type { ElectronHostProfile } from '@hosts/electron';
import type { RemoteHostSourceMode } from '@shared/remote-host';

import {
  copyRemoteHostProfileDocument,
  parseRemoteHostProfileDocument,
  REMOTE_HOST_PROFILE_SCHEMA_VERSION,
  type RemoteHostProfileDocument,
} from './profile-document';

export interface RemoteHostProfileBackend {
  read(): unknown;
  write(value: RemoteHostProfileDocument): void;
}
export interface RemoteHostProfileIdFactory {
  create(scope: 'client' | 'profile'): string;
}

export class RemoteHostProfileStore {
  constructor(
    private readonly backend: RemoteHostProfileBackend,
    private readonly ids: RemoteHostProfileIdFactory,
  ) {}

  load(): RemoteHostProfileDocument {
    const persisted = this.backend.read();
    if (persisted === undefined || persisted === null) {
      const initial = this.initialDocument();
      this.backend.write(copyRemoteHostProfileDocument(initial));
      return initial;
    }
    const parsed = parseRemoteHostProfileDocument(persisted);
    if (parsed.migrated) this.backend.write(copyRemoteHostProfileDocument(parsed.document));
    return copyRemoteHostProfileDocument(parsed.document);
  }

  save(
    profiles: readonly ElectronHostProfile[],
    sourceMode: RemoteHostSourceMode,
    selectedRemoteProfileId: string | null,
  ): void {
    const parsed = parseRemoteHostProfileDocument({
      schemaVersion: REMOTE_HOST_PROFILE_SCHEMA_VERSION,
      sourceMode,
      selectedRemoteProfileId,
      profiles: structuredClone(profiles),
    });
    this.backend.write(copyRemoteHostProfileDocument(parsed.document));
  }

  private initialDocument(): RemoteHostProfileDocument {
    const profile: ElectronHostProfile = {
      id: `standalone-${this.ids.create('profile')}`,
      label: '本机',
      topology: 'standalone',
      clientId: `electron-${this.ids.create('client')}`,
    };
    return {
      schemaVersion: REMOTE_HOST_PROFILE_SCHEMA_VERSION,
      sourceMode: 'local',
      selectedRemoteProfileId: null,
      profiles: [profile],
    };
  }
}
