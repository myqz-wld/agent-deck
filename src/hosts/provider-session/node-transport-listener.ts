import type { Duplex } from 'node:stream';

import { UnixSocketDaemonListener, type DaemonListener } from '@hosts/daemon';
import { openProviderSessionTransportPath } from './node-transport-path';

export interface ProviderSessionTransportListenerInput {
  readonly platform: NodeJS.Platform;
  readonly privateRoot: string;
  readonly runtimeDirectory: string;
  readonly socketPath: string;
}

class DescriptorBoundListener implements DaemonListener {
  constructor(
    private readonly closePath: () => void,
    private readonly delegate: UnixSocketDaemonListener,
  ) {}

  start(
    onConnection: (stream: Duplex) => void,
    onFailure?: (error: Error) => void,
  ): Promise<void> {
    return this.delegate.start(onConnection, onFailure);
  }

  async stop(): Promise<void> {
    try {
      await this.delegate.stop();
    } finally {
      this.closePath();
    }
  }
}

/** Binds long Linux volume paths through one identity-pinned directory fd. */
export function createProviderSessionTransportListener(
  input: ProviderSessionTransportListenerInput,
): DaemonListener {
  const path = openProviderSessionTransportPath(input);
  if (path.connectPath === input.socketPath) {
    return new UnixSocketDaemonListener(input.socketPath, input.runtimeDirectory);
  }
  try {
    return new DescriptorBoundListener(
      path.close,
      new UnixSocketDaemonListener(
        input.socketPath,
        input.runtimeDirectory,
        undefined,
        path.connectPath,
      ),
    );
  } catch (error) {
    path.close();
    throw error;
  }
}
