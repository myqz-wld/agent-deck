import {
  validateElectronHostProfile,
  type ElectronHostProfile,
  type ElectronHostRegistry,
  type ElectronHostState,
  type RemoteElectronHostProfile,
} from '@hosts/electron';
import type { RemoteHostProfileDraftDto, RemoteHostSourceMode } from '@shared/remote-host';

import type { RemoteHostCredentialSelections } from './credential-selections';
import type { RemoteHostProfileDocument } from './profile-document';
import type { RemoteHostProfileStore } from './profile-store';

export interface RemoteHostProfileControllerOptions {
  registry: ElectronHostRegistry;
  store: RemoteHostProfileStore;
  selections: RemoteHostCredentialSelections;
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
    if (!draft.identitySelectionId || !draft.knownHostsSelectionId) {
      throw new Error('New remote profiles require both credential files');
    }
    const identityFile = this.options.selections.resolve('identity-file', draft.identitySelectionId);
    const knownHostsFile = this.options.selections.resolve('known-hosts-file', draft.knownHostsSelectionId);
    const suffix = this.options.createId();
    const id = `remote-${suffix}`;
    const profile = this.buildProfile(id, `electron-${suffix}`, draft, identityFile, knownHostsFile);
    this.options.registry.register(profile);
    try {
      if (this.selectedRemoteProfileIdValue === null) this.selectedRemoteProfileIdValue = id;
      this.persist();
    } catch (error) {
      if (this.selectedRemoteProfileIdValue === id) this.selectedRemoteProfileIdValue = null;
      await this.options.registry.remove(id);
      throw error;
    }
    this.options.selections.consume([draft.identitySelectionId, draft.knownHostsSelectionId]);
    this.options.onProfileRescope(id);
    return id;
  }

  async update(profileId: string, draft: RemoteHostProfileDraftDto): Promise<void> {
    const current = this.requireRemote(profileId);
    const previousState = this.options.registry.state(profileId);
    const reconnect = shouldReconnect(previousState);
    const identityFile = draft.identitySelectionId
      ? this.options.selections.resolve('identity-file', draft.identitySelectionId)
      : current.ssh.identityFile;
    const knownHostsFile = draft.knownHostsSelectionId
      ? this.options.selections.resolve('known-hosts-file', draft.knownHostsSelectionId)
      : current.ssh.knownHostsFile;
    const replacement = this.buildProfile(
      current.id,
      current.clientId,
      draft,
      identityFile,
      knownHostsFile,
    );
    const wasSelected = this.options.registry.selectedProfileId === profileId;
    this.options.onProfileRescope(profileId);
    await this.options.registry.remove(profileId);
    let replacementRegistered = false;
    try {
      this.options.registry.register(replacement);
      replacementRegistered = true;
      if (wasSelected) this.options.registry.select(profileId);
      this.persist();
    } catch (error) {
      if (replacementRegistered) await this.options.registry.remove(profileId).catch(() => undefined);
      this.options.registry.register(current);
      if (wasSelected) this.options.registry.select(profileId);
      this.persist();
      throw error;
    }
    this.options.selections.consume([
      ...(draft.identitySelectionId ? [draft.identitySelectionId] : []),
      ...(draft.knownHostsSelectionId ? [draft.knownHostsSelectionId] : []),
    ]);
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
    this.requireRemote(profileId);
    await this.options.registry.connect(profileId);
  }

  async disconnect(profileId: string): Promise<void> {
    this.requireRemote(profileId);
    this.options.onProfileRescope(profileId);
    await this.options.registry.disconnect(profileId);
  }

  stopAll(): Promise<void> {
    this.options.selections.clear();
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

  private buildProfile(
    id: string,
    clientId: string,
    draft: RemoteHostProfileDraftDto,
    identityFile: string,
    knownHostsFile: string,
  ): RemoteElectronHostProfile {
    const profile: RemoteElectronHostProfile = {
      id,
      label: draft.label,
      clientId,
      topology: draft.topology,
      ssh: {
        id,
        label: draft.label,
        topology: draft.topology,
        hostname: draft.hostname,
        port: draft.port,
        username: draft.username,
        identityFile,
        knownHostsFile,
        ...(draft.expectedInstanceId ? { expectedInstanceId: draft.expectedInstanceId } : {}),
        ...(draft.hostKeyAlias ? { hostKeyAlias: draft.hostKeyAlias } : {}),
      },
    };
    validateElectronHostProfile(profile);
    return profile;
  }
}
