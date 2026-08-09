import { closeSync, constants, openSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ProviderSessionTransportPathInput {
  readonly platform: NodeJS.Platform;
  readonly privateRoot: string;
  readonly socketPath: string;
}

export interface ProviderSessionTransportPathLease {
  readonly connectPath: string;
  close(): void;
}

/** Opens the exact private root when a Linux volume data path is too long for sockaddr_un. */
export function openProviderSessionTransportPath(
  input: ProviderSessionTransportPathInput,
): ProviderSessionTransportPathLease {
  if (Buffer.byteLength(input.socketPath) <= 103) {
    return Object.freeze({ connectPath: input.socketPath, close: () => undefined });
  }
  if (input.platform !== 'linux') {
    throw new Error('provider supervisor socket exceeds its portable host bound');
  }
  const suffix = relative(input.privateRoot, input.socketPath);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('provider supervisor socket escapes its private root');
  }
  const descriptor = openSync(
    input.privateRoot,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  let open = true;
  return Object.freeze({
    connectPath: join('/proc/self/fd', String(descriptor), suffix),
    close: (): void => {
      if (!open) return;
      open = false;
      closeSync(descriptor);
    },
  });
}
