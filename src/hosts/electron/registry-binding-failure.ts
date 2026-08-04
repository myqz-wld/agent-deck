import type { ElectronHostClientBinding } from './client-binding';
import type { ElectronHostState } from './model';
import type { RegistryEntry } from './registry-entry';

export interface RegistryBindingFailureActions {
  retire(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    epoch: number,
  ): Promise<void>;
  updateState(entry: RegistryEntry, patch: Partial<ElectronHostState>): void;
}

export function applyRegistryConnectError(
  entry: RegistryEntry,
  error: unknown,
  actions: RegistryBindingFailureActions,
): void {
  const code = registryErrorCode(error);
  const incompatible = isIncompatibleCode(code);
  if (incompatible && entry.binding) {
    actions.retire(entry, entry.binding, ++entry.epoch);
  }
  actions.updateState(entry, {
    status: incompatible ? 'incompatible' : 'offline',
    error: { code, message: registryErrorMessage(error) },
  });
}

export function failRegistryBindingSetup(
  entry: RegistryEntry,
  binding: ElectronHostClientBinding,
  error: unknown,
  actions: RegistryBindingFailureActions,
): never {
  const code = registryErrorCode(error);
  const incompatible = isIncompatibleCode(code);
  actions.retire(entry, binding, ++entry.epoch);
  actions.updateState(entry, {
    status: incompatible ? 'incompatible' : 'offline',
    error: { code, message: registryErrorMessage(error) },
  });
  throw error;
}

export function registryErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'connection_failed';
}

export function registryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIncompatibleCode(code: string): boolean {
  return new Set([
    'host_key_verification_failed',
    'incompatible_handshake',
    'incompatible_protocol',
    'protocol_violation',
  ]).has(code);
}
