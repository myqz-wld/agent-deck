import {
  type AgentDeckClient,
  type CoreMethodMap,
  type HostHello,
} from '@contracts/index';
import { CURRENT_PROTOCOL_VERSION } from '@protocol/version';

import type { ElectronHostClientBinding } from './client-binding';
import { retireElectronBinding } from './binding-retirement';
import {
  hostQualifiedCacheKey,
  identityFromHostHello,
  type HostQualifiedIdentity,
} from './identity';
import { validateElectronHostHello } from './host-hello';
import {
  initialElectronHostState,
  initialNavigationState,
  type ElectronHostEvent,
  type ElectronHostNavigationState,
  type ElectronHostProfile,
  type ElectronHostState,
  type ElectronHostStateSubscription,
} from './model';
import { validateElectronHostProfile } from './profile-validation';
import { publicElectronHostProfile, type ElectronHostPublicProfile } from './public-profile';
import {
  applyRegistryConnectError,
  failRegistryBindingSetup,
  registryErrorMessage,
} from './registry-binding-failure';
import type { RegistryEntry } from './registry-entry';
import { startRegistryConnect } from './registry-connect';
import { disconnectRegistryEntry } from './registry-disconnect';
import {
  handleRegistryEvent,
  handleRegistryTransportState,
} from './registry-observers';
import { copyHostProfile, copyHostState, freezeHostProfile } from './registry-snapshots';
import { ElectronRegistryLifecycleGate } from './registry-lifecycle-gate';

export type ElectronHostClientFactory = (
  profile: ElectronHostProfile,
) => ElectronHostClientBinding;

export interface ElectronHostRegistryOptions {
  appVersion: string;
  createClient: ElectronHostClientFactory;
}

export class ElectronHostRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly stateListeners = new Set<(state: ElectronHostState) => void>();
  private readonly eventListeners = new Set<(event: ElectronHostEvent) => void>();
  private readonly selectionListeners = new Set<(profileId: string | null) => void>();
  private readonly lifecycle = new ElectronRegistryLifecycleGate();
  private selectedProfileIdValue: string | null = null;

  constructor(private readonly options: ElectronHostRegistryOptions) {
    if (!options.appVersion) throw new Error('Electron host registry requires appVersion');
  }

  register(profile: ElectronHostProfile): void {
    validateElectronHostProfile(profile);
    this.lifecycle.assertMutable(profile.id, 'register profile');
    if (this.entries.has(profile.id)) throw new Error(`Host profile already exists: ${profile.id}`);
    const storedProfile = freezeHostProfile(profile);
    this.entries.set(profile.id, {
      profile: storedProfile,
      state: initialElectronHostState(storedProfile),
      navigation: initialNavigationState(),
      identity: null,
      binding: null,
      transportSubscription: null,
      eventSubscription: null,
      connectPromise: null,
      transportState: null,
      retirement: null,
      epoch: 0,
    });
  }

  listProfiles(): readonly ElectronHostProfile[] {
    return [...this.entries.values()].map((entry) => copyHostProfile(entry.profile));
  }

  listPublicProfiles(): readonly ElectronHostPublicProfile[] {
    return [...this.entries.values()].map((entry) => publicElectronHostProfile(entry.profile));
  }

  listStates(): readonly ElectronHostState[] {
    return [...this.entries.values()].map((entry) => copyHostState(entry.state));
  }

  state(profileId: string): ElectronHostState {
    return copyHostState(this.requireEntry(profileId).state);
  }

  onState(listener: (state: ElectronHostState) => void): ElectronHostStateSubscription {
    this.stateListeners.add(listener);
    return { close: () => this.stateListeners.delete(listener) };
  }

  onEvent(listener: (event: ElectronHostEvent) => void): ElectronHostStateSubscription {
    this.eventListeners.add(listener);
    return { close: () => this.eventListeners.delete(listener) };
  }

  get selectedProfileId(): string | null {
    return this.selectedProfileIdValue;
  }

  select(profileId: string): ElectronHostState {
    const entry = this.requireEntry(profileId);
    this.lifecycle.assertMutable(profileId, 'select profile');
    if (this.selectedProfileIdValue !== profileId) {
      this.selectedProfileIdValue = profileId;
      for (const listener of this.selectionListeners) {
        try {
          listener(profileId);
        } catch {}
      }
    }
    return copyHostState(entry.state);
  }

  onSelection(listener: (profileId: string | null) => void): ElectronHostStateSubscription {
    this.selectionListeners.add(listener);
    return { close: () => this.selectionListeners.delete(listener) };
  }

  selectedClient(): AgentDeckClient<CoreMethodMap> | null {
    return this.selectedProfileIdValue
      ? this.requireEntry(this.selectedProfileIdValue).binding?.client ?? null
      : null;
  }

  connect(profileId: string): Promise<HostHello> {
    const entry = this.requireEntry(profileId);
    try {
      this.lifecycle.assertMutable(profileId, 'connect');
    } catch (error) {
      return Promise.reject(error);
    }
    if (entry.connectPromise) return entry.connectPromise;
    const epoch = ++entry.epoch;
    return startRegistryConnect(entry, () => this.connectEntry(entry, epoch));
  }

  getClient(profileId: string): AgentDeckClient<CoreMethodMap> | null {
    return this.requireEntry(profileId).binding?.client ?? null;
  }

  identity(profileId: string): HostQualifiedIdentity | null {
    const identity = this.requireEntry(profileId).identity;
    return identity ? { ...identity } : null;
  }

  cacheKey(profileId: string, namespace: string, entityId: string): string {
    const identity = this.requireEntry(profileId).identity;
    if (!identity) throw new Error(`Host profile is not identity-qualified: ${profileId}`);
    return hostQualifiedCacheKey(identity, namespace, entityId);
  }

  navigation(profileId: string): ElectronHostNavigationState {
    return { ...this.requireEntry(profileId).navigation };
  }

  updateNavigation(
    profileId: string,
    patch: Partial<Pick<ElectronHostNavigationState, 'route' | 'selectedSessionId'>>,
  ): ElectronHostNavigationState {
    const entry = this.requireEntry(profileId);
    this.lifecycle.assertMutable(profileId, 'update navigation');
    entry.navigation = {
      ...entry.navigation,
      ...patch,
      revision: entry.navigation.revision + 1,
    };
    return { ...entry.navigation };
  }

  async disconnect(profileId: string, reason = 'transport-stopped'): Promise<void> {
    const entry = this.requireEntry(profileId);
    await this.disconnectEntry(entry, reason, false);
  }

  private async disconnectEntry(
    entry: RegistryEntry,
    reason: string,
    awaitConnecting: boolean,
  ): Promise<void> {
    await disconnectRegistryEntry(entry, reason, awaitConnecting, {
      isCurrent: (target) => this.entries.get(target.profile.id) === target,
      retire: (target, binding, epoch) => this.retireBinding(target, binding, epoch),
      updateState: (target, patch) => this.updateState(target, patch),
    });
  }

  stopAll(reason = 'app-shutdown'): Promise<void> {
    return this.lifecycle.stop(() => this.stopAllEntries(reason));
  }

  private async stopAllEntries(reason: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.disconnectEntry(entry, reason, true)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'One or more host transports failed to stop');
  }

  remove(profileId: string): Promise<void> {
    const entry = this.requireEntry(profileId);
    return this.lifecycle.remove(profileId, () => this.removeEntry(entry));
  }

  private async removeEntry(entry: RegistryEntry): Promise<void> {
    await this.disconnectEntry(entry, 'profile-removed', true);
    if (
      this.entries.get(entry.profile.id) !== entry ||
      entry.binding ||
      entry.retirement ||
      entry.connectPromise
    ) {
      throw new Error('Host profile removal did not reach a quiescent lifecycle state');
    }
    this.entries.delete(entry.profile.id);
    const profileId = entry.profile.id;
    if (this.selectedProfileIdValue === profileId) {
      this.selectedProfileIdValue = null;
      for (const listener of this.selectionListeners) {
        try {
          listener(null);
        } catch {}
      }
    }
  }

  private async connectEntry(entry: RegistryEntry, epoch: number): Promise<HostHello> {
    try {
      if (entry.retirement) await entry.retirement;
    } catch (error) {
      if (entry.epoch === epoch) this.applyRetirementError(entry, error);
      throw error;
    }
    this.lifecycle.assertMutable(entry.profile.id, 'install binding');
    if (this.entries.get(entry.profile.id) !== entry || entry.epoch !== epoch) {
      throw new Error('Host connection was replaced before transport cleanup completed');
    }
    if (
      entry.binding &&
      entry.identity &&
      (entry.state.status === 'connected' || this.isLiveWorkerOffline(entry))
    ) {
      return this.reaffirmLiveBinding(entry, epoch);
    }
    if (!entry.binding) this.installBinding(entry, epoch);
    if (entry.epoch !== epoch) {
      throw new Error('Host connection was replaced during binding setup');
    }
    const binding = entry.binding;
    if (!binding) throw new Error('Host client factory returned no binding');
    this.updateState(entry, { status: 'connecting', error: null });
    let hello: HostHello;
    try {
      hello = await binding.client.connect(this.clientHello(entry));
      if (entry.epoch !== epoch || entry.binding !== binding) {
        throw new Error('Host connection was replaced while connecting');
      }
    } catch (error) {
      if (entry.epoch === epoch && entry.binding === binding) this.applyConnectError(entry, error);
      throw error;
    }
    try {
      this.applyHello(entry, hello);
      const previousSubscription = entry.eventSubscription;
      entry.eventSubscription = null;
      previousSubscription?.close();
      const subscription = binding.client.subscribe(entry.state.eventRevision, (event) =>
        this.handleEvent(entry, binding, event),
      );
      if (entry.epoch !== epoch || entry.binding !== binding) {
        subscription.close();
        if (entry.retirement) await entry.retirement;
        throw new Error('Host connection was replaced during registry setup');
      }
      entry.eventSubscription = subscription;
      if (!this.isLiveWorkerOffline(entry)) {
        this.updateState(entry, { status: 'connected', error: null });
      }
      return hello;
    } catch (error) {
      if (entry.binding === binding) {
        this.failBindingSetup(entry, binding, error);
      }
      throw error;
    }
  }

  private installBinding(entry: RegistryEntry, epoch: number): void {
    this.lifecycle.assertMutable(entry.profile.id, 'install binding');
    const binding = this.options.createClient(copyHostProfile(entry.profile));
    entry.binding = binding;
    entry.transportState = null;
    try {
      const subscription = binding.observeTransport?.((state) =>
        this.handleTransportState(entry, binding, state),
      );
      if (entry.epoch !== epoch || entry.binding !== binding) {
        subscription?.close();
        throw new Error('Host binding was replaced during transport observation setup');
      }
      entry.transportSubscription = subscription ?? null;
    } catch (error) {
      if (entry.binding === binding) {
        this.failBindingSetup(entry, binding, error);
      }
      throw error;
    }
  }

  private clientHello(entry: RegistryEntry) {
    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      appVersion: this.options.appVersion,
      clientId: entry.profile.clientId,
      requestedTopology: entry.profile.topology,
      lastEventRevision: entry.state.eventRevision,
    } as const;
  }

  private applyHello(entry: RegistryEntry, hello: HostHello): void {
    validateElectronHostHello(entry.profile, hello, entry.identity?.instanceId ?? null);
    entry.identity = identityFromHostHello(entry.profile.id, hello);
    this.updateState(entry, {
      instanceId: hello.instanceId,
      authoritativeCoreId: hello.authoritativeCore.id,
      workerGeneration: hello.authoritativeCore.generation,
      capabilities: [...hello.capabilities],
    });
  }

  private handleTransportState(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    state: Parameters<typeof handleRegistryTransportState>[2],
  ): void {
    handleRegistryTransportState(entry, binding, state, {
      applyHello: (target, hello) => this.applyHello(target, hello),
      applyConnectError: (target, error) => this.applyConnectError(target, error),
      retireIncompatible: (target, targetBinding) =>
        this.retireIncompatible(target, targetBinding),
      updateState: (target, patch) => this.updateState(target, patch),
      emitEvent: (event) => this.emitEvent(event),
    });
  }

  private handleEvent(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    event: Omit<ElectronHostEvent, 'profileId'>,
  ): void {
    handleRegistryEvent(entry, binding, event, {
      applyHello: (target, hello) => this.applyHello(target, hello),
      applyConnectError: (target, error) => this.applyConnectError(target, error),
      retireIncompatible: (target, targetBinding) =>
        this.retireIncompatible(target, targetBinding),
      updateState: (target, patch) => this.updateState(target, patch),
      emitEvent: (qualified) => this.emitEvent(qualified),
    });
  }

  private emitEvent(qualified: ElectronHostEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(structuredClone(qualified));
      } catch {}
    }
  }

  private retireIncompatible(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
  ): void {
    if (entry.binding !== binding) return;
    const epoch = ++entry.epoch;
    this.retireBinding(entry, binding, epoch);
  }

  private applyConnectError(entry: RegistryEntry, error: unknown): void {
    applyRegistryConnectError(entry, error, {
      retire: (target, binding, epoch) => this.retireBinding(target, binding, epoch),
      updateState: (target, patch) => this.updateState(target, patch),
    });
  }

  private failBindingSetup(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    error: unknown,
  ): never {
    return failRegistryBindingSetup(entry, binding, error, {
      retire: (target, targetBinding, epoch) =>
        this.retireBinding(target, targetBinding, epoch),
      updateState: (target, patch) => this.updateState(target, patch),
    });
  }

  private isLiveWorkerOffline(entry: RegistryEntry): boolean {
    return (
      entry.profile.topology === 'relay' &&
      entry.transportState?.status === 'offline' &&
      entry.transportState.errorCode === 'worker_offline' &&
      entry.transportState.hello !== null
    );
  }

  private reaffirmLiveBinding(entry: RegistryEntry, epoch: number): Promise<HostHello> {
    const binding = entry.binding;
    if (!binding) return Promise.reject(new Error('Host binding disappeared'));
    return binding.client
      .connect(this.clientHello(entry))
      .then((hello) => {
        if (entry.epoch !== epoch || entry.binding !== binding) {
          throw new Error('Host connection was replaced while reconnecting');
        }
        this.applyHello(entry, hello);
        if (!this.isLiveWorkerOffline(entry)) {
          this.updateState(entry, { status: 'connected', error: null });
        }
        return hello;
      })
      .catch((error: unknown) => {
        if (entry.epoch === epoch && entry.binding === binding) {
          this.applyConnectError(entry, error);
        }
        throw error;
      });
  }

  private retireBinding(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    epoch: number,
  ): Promise<void> {
    if (entry.binding !== binding) return entry.retirement ?? Promise.resolve();
    entry.binding = null;
    entry.connectPromise = null;
    entry.transportState = null;
    const subscriptions = [entry.transportSubscription, entry.eventSubscription] as const;
    entry.transportSubscription = null;
    entry.eventSubscription = null;
    const retirement = retireElectronBinding(binding, subscriptions);
    entry.retirement = retirement;
    void retirement.then(
      () => {
        if (entry.retirement === retirement) entry.retirement = null;
      },
      (error) => {
        if (entry.epoch === epoch && entry.binding === null) {
          this.applyRetirementError(entry, error);
        }
      },
    );
    return retirement;
  }

  private applyRetirementError(entry: RegistryEntry, error: unknown): void {
    this.updateState(entry, {
      status: 'offline',
      error: {
        code: 'transport-close-failed',
        message: `Desktop transport cleanup failed: ${registryErrorMessage(error)}`,
      },
    });
  }

  private updateState(entry: RegistryEntry, patch: Partial<ElectronHostState>): void {
    entry.state = { ...entry.state, ...patch };
    for (const listener of this.stateListeners) {
      try {
        listener(copyHostState(entry.state));
      } catch {}
    }
  }

  private requireEntry(profileId: string): RegistryEntry {
    const entry = this.entries.get(profileId);
    if (!entry) throw new Error(`Unknown host profile: ${profileId}`);
    return entry;
  }
}
