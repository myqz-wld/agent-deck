import type { HostHello } from '@contracts/index';

import type { RegistryEntry } from './registry-entry';

/** Installs the public waiter before connect work can reenter registry lifecycle observers. */
export function startRegistryConnect(
  entry: RegistryEntry,
  run: () => Promise<HostHello>,
): Promise<HostHello> {
  let resolve!: (hello: HostHello) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<HostHello>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  entry.connectPromise = promise;
  void run().then(resolve, reject);
  void promise.then(
    () => clear(entry, promise),
    () => clear(entry, promise),
  );
  return promise;
}

function clear(entry: RegistryEntry, promise: Promise<HostHello>): void {
  if (entry.connectPromise === promise) entry.connectPromise = null;
}
