import type { Duplex, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  encodeBridgeAdmission,
  type BridgeAdmission,
} from '@protocol/index';
import { connectUnixSocket } from '@hosts/ssh-bridge/tunnel';

export interface ForcedCommandTunnelOptions {
  readonly admission: BridgeAdmission;
  readonly socketPath: string;
  readonly expectedOriginalCommand: string;
  readonly originalCommand: string | undefined;
  readonly input: Readable;
  readonly output: Writable;
  readonly connect?: (socketPath: string) => Promise<Duplex>;
}

/** Provisioned argv owns identity; SSH_ORIGINAL_COMMAND is only an exact anti-confusion fence. */
export async function runForcedCommandTunnel(
  options: ForcedCommandTunnelOptions,
): Promise<void> {
  if (options.originalCommand !== options.expectedOriginalCommand) {
    throw new Error('SSH original command does not match the provisioned forced command');
  }
  const socket = await (options.connect ?? connectUnixSocket)(options.socketPath);
  try {
    const admission = encodeBridgeAdmission(options.admission);
    await new Promise<void>((resolve, reject) => {
      socket.write(admission, (error) => (error ? reject(error) : resolve()));
    });
    await Promise.all([
      pipeline(options.input, socket),
      pipeline(socket, options.output, { end: false }),
    ]);
  } finally {
    socket.destroy();
  }
}
