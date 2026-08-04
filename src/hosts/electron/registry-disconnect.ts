import type { ElectronHostClientBinding } from './client-binding';
import type { ElectronHostState } from './model';
import type { RegistryEntry } from './registry-entry';

export interface RegistryDisconnectActions {
  isCurrent(entry: RegistryEntry): boolean;
  retire(
    entry: RegistryEntry,
    binding: ElectronHostClientBinding,
    epoch: number,
  ): Promise<void>;
  updateState(entry: RegistryEntry, patch: Partial<ElectronHostState>): void;
}

export async function disconnectRegistryEntry(
  entry: RegistryEntry,
  reason: string,
  awaitConnecting: boolean,
  actions: RegistryDisconnectActions,
): Promise<void> {
  const epoch = ++entry.epoch;
  const connecting = entry.connectPromise;
  const binding = entry.binding;
  const retirement = binding ? actions.retire(entry, binding, epoch) : entry.retirement;
  let closeError: unknown;
  try {
    if (retirement) await retirement;
    if (awaitConnecting && connecting) await Promise.allSettled([connecting]);
  } catch (error) {
    closeError = error;
  } finally {
    if (actions.isCurrent(entry) && entry.epoch === epoch && entry.binding === null) {
      actions.updateState(entry, {
        status: 'offline',
        error: closeError
          ? {
              code: 'transport-close-failed',
              message: `Desktop transport cleanup failed: ${errorMessage(closeError)}`,
            }
          : {
              code: reason,
              message: 'Desktop transport is stopped; Core ownership is unchanged',
            },
      });
    }
  }
  if (closeError) throw closeError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
