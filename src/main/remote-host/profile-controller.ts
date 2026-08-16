import {
  validateElectronHostProfile,
  type ElectronHostProfile,
  type ElectronHostRegistry,
  type ElectronHostState,
  type RemoteElectronHostProfile,
} from '@hosts/electron';
import type { RemoteHostProfileDraftDto, RemoteHostSourceMode } from '@shared/remote-host';

import {
  connectionHostKeyFingerprint,
  type RemoteHostConnectionSelections,
} from './connection-selections';
import type {
  InstalledRemoteHostCredential,
  RemoteHostCredentialMaterialStore,
} from './credential-material-store';
import type { RemoteHostProfileDocument } from './profile-document';
import type { RemoteHostProfileStore } from './profile-store';

export interface RemoteHostProfileControllerOptions {
  registry: ElectronHostRegistry;
  store: RemoteHostProfileStore;
  connections: RemoteHostConnectionSelections;
  materials: RemoteHostCredentialMaterialStore;
  createId: () => string;
  onProfileRescope: (profileId: string) => void;
  onSourceRescope: () => void;
}

function shouldReconnect(state: ElectronHostState): boolean {
  return ['connected', 'connecting', 'reconnecting'].includes(state.status);
}

export class RemoteHostProfileController {
  private sourceModeValue: RemoteHostSourceMode;
  private selectedRemoteProfileIdValue: string | null;

  constructor(
    document: RemoteHostProfileDocument,
    private readonly options: RemoteHostProfileControllerOptions,
  ) {
    for (const profile of document.profiles) options.registry.register(profile);
    this.sourceModeValue = document.sourceMode;
    this.selectedRemoteProfileIdValue = document.selectedRemoteProfileId;
    options.registry.select(
      document.sourceMode === 'remote'
        ? document.selectedRemoteProfileId!
        : this.standalone().id,
    );
  }

  get sourceMode(): RemoteHostSourceMode {
    return this.sourceModeValue;
  }

  get selectedRemoteProfileId(): string | null {
    return this.selectedRemoteProfileIdValue;
  }

  profiles(): readonly ElectronHostProfile[] {
    return this.options.registry.listProfiles();
  }

  async add(draft: RemoteHostProfileDraftDto): Promise<string> {
    if (!draft.connectionSelectionId) throw new Error('请先导入连接凭证');
    const credential = this.options.connections.resolve(draft.connectionSelectionId);
    const suffix = this.options.createId();
    const id = `remote-${suffix}`;
    const material = this.options.materials.install(credential);
    const profile = this.buildCredentialProfile(
      id,
      `electron-${suffix}`,
      draft.label,
      credential,
      material,
    );
    let registered = false;
    try {
      this.options.registry.register(profile);
      registered = true;
      if (this.selectedRemoteProfileIdValue === null) this.selectedRemoteProfileIdValue = id;
      this.persist();
    } catch (error) {
      if (this.selectedRemoteProfileIdValue === id) this.selectedRemoteProfileIdValue = null;
      if (registered) await this.options.registry.remove(id).catch(() => undefined);
      this.options.materials.dispose(material);
      throw error;
    }
    this.options.connections.consume(draft.connectionSelectionId);
    this.options.onProfileRescope(id);
    return id;
  }

  async update(profileId: string, draft: RemoteHostProfileDraftDto): Promise<void> {
    const current = this.requireRemote(profileId);
    const previousState = this.options.registry.state(profileId);
    const reconnect = shouldReconnect(previousState);
    const credential = draft.connectionSelectionId
      ? this.options.connections.resolve(draft.connectionSelectionId)
      : null;
    const wasSelected = this.options.registry.selectedProfileId === profileId;
    this.options.onProfileRescope(profileId);
    await this.options.registry.remove(profileId);
    let installed: InstalledRemoteHostCredential | null = null;
    let replacementRegistered = false;
    try {
      installed = credential ? this.options.materials.install(credential) : null;
      const replacement = credential
        ? this.buildCredentialProfile(
            current.id,
            current.clientId,
            draft.label,
            credential,
            installed!,
          )
        : this.relabelProfile(current, draft.label);
      this.options.registry.register(replacement);
      replacementRegistered = true;
      if (wasSelected) this.options.registry.select(profileId);
      this.persist();
    } catch (error) {
      if (replacementRegistered) await this.options.registry.remove(profileId).catch(() => undefined);
      this.options.registry.register(current);
      if (wasSelected) this.options.registry.select(profileId);
      this.persist();
      if (installed) this.options.materials.dispose(installed);
      throw error;
    }
    if (installed) this.options.materials.dispose(this.material(current));
    if (draft.connectionSelectionId) this.options.connections.consume(draft.connectionSelectionId);
    if (reconnect) await this.options.registry.connect(profileId).catch(() => undefined);
  }

  async remove(profileId: string): Promise<void> {
    const current = this.requireRemote(profileId);
    const previousMode = this.sourceModeValue;
    const previousSelected = this.selectedRemoteProfileIdValue;
    const wasSelected = previousSelected === profileId;
    this.options.onProfileRescope(profileId);
    await this.options.registry.remove(profileId);
    if (wasSelected) {
      const nextRemote = this.profiles().find((profile) => profile.topology !== 'standalone');
      this.selectedRemoteProfileIdValue = nextRemote?.id ?? null;
      if (!nextRemote) this.sourceModeValue = 'local';
      this.options.registry.select(
        this.sourceModeValue === 'remote' && nextRemote
          ? nextRemote.id
          : this.standalone().id,
      );
      this.options.onSourceRescope();
    }
    try {
      this.persist();
    } catch (error) {
      this.options.registry.register(current);
      this.sourceModeValue = previousMode;
      this.selectedRemoteProfileIdValue = previousSelected;
      this.options.registry.select(
        previousMode === 'remote' && previousSelected
          ? previousSelected
          : this.standalone().id,
      );
      this.persist();
      throw error;
    }
    this.options.materials.dispose(this.material(current));
  }

  select(profileId: string): void {
    this.requireRemote(profileId);
    const previous = this.selectedRemoteProfileIdValue;
    if (previous === profileId) return;
    if (this.sourceModeValue === 'remote') this.options.registry.select(profileId);
    this.selectedRemoteProfileIdValue = profileId;
    try {
      this.persist();
    } catch (error) {
      this.options.registry.select(
        this.sourceModeValue === 'remote' && previous ? previous : this.standalone().id,
      );
      this.selectedRemoteProfileIdValue = previous;
      throw error;
    }
    if (this.sourceModeValue === 'remote') this.options.onSourceRescope();
  }

  setSourceMode(mode: RemoteHostSourceMode): void {
    if (mode === this.sourceModeValue) return;
    if (mode === 'remote' && !this.selectedRemoteProfileIdValue) {
      throw new Error('Configure a remote profile before selecting Remote mode');
    }
    if (mode === 'remote') {
      this.requireCurrentCredential(this.requireRemote(this.selectedRemoteProfileIdValue!));
    }
    const previous = this.sourceModeValue;
    this.sourceModeValue = mode;
    this.options.registry.select(
      mode === 'remote' ? this.selectedRemoteProfileIdValue! : this.standalone().id,
    );
    try {
      this.persist();
    } catch (error) {
      this.sourceModeValue = previous;
      this.options.registry.select(
        previous === 'remote' ? this.selectedRemoteProfileIdValue! : this.standalone().id,
      );
      throw error;
    }
    this.options.onSourceRescope();
  }

  async connect(profileId: string): Promise<void> {
    this.requireCurrentCredential(this.requireRemote(profileId));
    await this.options.registry.connect(profileId);
  }

  async disconnect(profileId: string): Promise<void> {
    this.requireRemote(profileId);
    this.options.onProfileRescope(profileId);
    await this.options.registry.disconnect(profileId);
  }

  stopAll(): Promise<void> {
    this.options.connections.clear();
    this.options.onSourceRescope();
    return this.options.registry.stopAll();
  }

  private persist(): void {
    this.options.store.save(
      this.profiles(),
      this.sourceModeValue,
      this.selectedRemoteProfileIdValue,
    );
  }

  private standalone(): ElectronHostProfile {
    const profile = this.profiles().find((candidate) => candidate.topology === 'standalone');
    if (!profile) throw new Error('Standalone fallback profile is missing');
    return profile;
  }

  private requireProfile(profileId: string): ElectronHostProfile {
    const profile = this.profiles().find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error('Unknown remote host profile');
    return profile;
  }

  private requireRemote(profileId: string): RemoteElectronHostProfile {
    const profile = this.requireProfile(profileId);
    if (profile.topology === 'standalone') {
      throw new Error('Standalone uses the existing local desktop flows');
    }
    return profile;
  }

  private requireCurrentCredential(profile: RemoteElectronHostProfile): void {
    if (profile.connectionCredentialStatus === 'refresh-required') {
      throw new Error('此远程配置来自旧版本，请编辑并重新导入连接凭据。');
    }
  }

  private buildCredentialProfile(
    id: string,
    clientId: string,
    label: string,
    credential: ReturnType<RemoteHostConnectionSelections['resolve']>,
    material: InstalledRemoteHostCredential,
  ): RemoteElectronHostProfile {
    const profile: RemoteElectronHostProfile = {
      id,
      label,
      clientId,
      topology: credential.topology,
      ssh: {
        id,
        label,
        topology: credential.topology,
        ...credential.endpoint,
        identityFile: material.identityFile,
        knownHostsFile: material.knownHostsFile,
        expectedInstanceId: credential.instanceId,
        expectedConnectionScope: credential.connectionScope,
        hostKeyFingerprint: connectionHostKeyFingerprint(credential),
      },
    };
    validateElectronHostProfile(profile);
    return profile;
  }

  private relabelProfile(current: RemoteElectronHostProfile, label: string): RemoteElectronHostProfile {
    const profile = { ...current, label, ssh: { ...current.ssh, label } };
    validateElectronHostProfile(profile);
    return profile;
  }

  private material(profile: RemoteElectronHostProfile): InstalledRemoteHostCredential {
    return {
      identityFile: profile.ssh.identityFile,
      knownHostsFile: profile.ssh.knownHostsFile,
    };
  }
}
