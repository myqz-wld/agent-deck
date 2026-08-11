import type { SshConnectionState } from '@clients/ssh';

import type { ElectronHostClientBinding } from './client-binding';
import type { ElectronHostEvent, ElectronHostState } from './model';
import type { RegistryEntry } from './registry-entry';

export interface RegistryObserverActions {
  applyHello(entry: RegistryEntry, hello: NonNullable<SshConnectionState['hello']>): void;
  applyConnectError(entry: RegistryEntry, error: unknown): void;
  retireIncompatible(entry: RegistryEntry, binding: ElectronHostClientBinding): void;
  updateState(entry: RegistryEntry, patch: Partial<ElectronHostState>): void;
  emitEvent(event: ElectronHostEvent): void;
}

export function handleRegistryTransportState(
  entry: RegistryEntry,
  binding: ElectronHostClientBinding,
  state: SshConnectionState,
  actions: RegistryObserverActions,
): void {
  if (entry.binding !== binding) return;
  try {
    entry.transportState = structuredClone(state);
  } catch {
    actions.updateState(entry, {
      status: 'incompatible',
      error: { code: 'protocol_violation', message: 'Transport state is not cloneable' },
    });
    actions.retireIncompatible(entry, binding);
    return;
  }
  if (state.hello) {
    try {
      actions.applyHello(entry, state.hello);
    } catch (error) {
      actions.applyConnectError(entry, error);
      return;
    }
  }
  const status = state.status === 'idle' || state.status === 'closed' ? 'offline' : state.status;
  actions.updateState(entry, {
    status,
    error:
      state.errorCode && state.reason
        ? { code: state.errorCode, message: state.reason }
        : null,
  });
  if (
    (status === 'incompatible' || state.errorCode === 'replay_gap') &&
    entry.binding === binding
  ) {
    actions.retireIncompatible(entry, binding);
  }
}

export function handleRegistryEvent(
  entry: RegistryEntry,
  binding: ElectronHostClientBinding,
  event: Omit<ElectronHostEvent, 'profileId'>,
  actions: RegistryObserverActions,
): void {
  if (entry.binding !== binding || event.revision <= entry.state.eventRevision) return;
  if (entry.state.instanceId && event.instanceId !== entry.state.instanceId) {
    actions.updateState(entry, {
      status: 'incompatible',
      error: { code: 'host_identity_mismatch', message: 'Event instanceId changed' },
    });
    actions.retireIncompatible(entry, binding);
    return;
  }
  actions.updateState(entry, { eventRevision: event.revision });
  actions.emitEvent({ ...event, profileId: entry.profile.id });
}
