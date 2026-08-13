import type { RegistryEntry } from './registry-entry';

/** A Relay can report Worker unavailability while its SSH channel remains healthy. */
export function isLiveWorkerOffline(entry: RegistryEntry): boolean {
  return (
    entry.profile.topology === 'relay' &&
    entry.transportState?.status === 'offline' &&
    entry.transportState.errorCode === 'worker_offline' &&
    entry.transportState.hello !== null
  );
}

/** Explicit Connect must replace an SSH client whose own retry chain already terminated. */
export function shouldReplaceTerminalTransport(entry: RegistryEntry): boolean {
  return (
    entry.binding !== null &&
    entry.transportState?.status === 'offline' &&
    !isLiveWorkerOffline(entry)
  );
}
