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
    return copyRemoteHostProfileDocument(parseRemoteHostProfileDocument(persisted));
  }

  save(
    profiles: readonly ElectronHostProfile[],
    sourceMode: RemoteHostSourceMode,
    selectedRemoteProfileId: string | null,
  ): void {
    const document = parseRemoteHostProfileDocument({
      schemaVersion: REMOTE_HOST_PROFILE_SCHEMA_VERSION,
      sourceMode,
      selectedRemoteProfileId,
      profiles: structuredClone(profiles),
    });
    this.backend.write(copyRemoteHostProfileDocument(document));
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
