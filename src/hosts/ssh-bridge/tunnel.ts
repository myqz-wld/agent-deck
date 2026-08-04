import { createConnection } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import type { Duplex, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  encodeBridgeAdmission,
  type BridgeClientAdmission,
} from '@protocol/index';

export const SSH_BRIDGE_ORIGINAL_COMMAND = 'agent-deck-bridge';

export interface SshClientBridgeTunnelOptions {
  readonly admission: BridgeClientAdmission;
  readonly socketPath: string;
  readonly originalCommand: string | undefined;
  readonly input: Readable;
  readonly output: Writable;
  readonly connect?: (socketPath: string) => Promise<Duplex>;
}

function assertSocketPath(socketPath: string): void {
  if (
    socketPath.length === 0 ||
    socketPath.includes('\0') ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath === '/'
  ) {
    throw new Error('Bridge socket path must be a normalized non-root absolute path');
  }
}

export function connectUnixSocket(socketPath: string): Promise<Duplex> {
  assertSocketPath(socketPath);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error): void => {
      socket.off('connect', onConnect);
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function writeAdmission(socket: Duplex, admission: BridgeClientAdmission): Promise<void> {
  const encoded = encodeBridgeAdmission(admission);
  return new Promise((resolve, reject) => {
    socket.write(encoded, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Runs only the fixed SSH stdio bridge; it never spawns a shell or owns remote Core lifecycle. */
export async function runSshClientBridgeTunnel(
  options: SshClientBridgeTunnelOptions,
): Promise<void> {
  if (options.originalCommand !== SSH_BRIDGE_ORIGINAL_COMMAND) {
    throw new Error('SSH original command does not match the Agent Deck bridge token');
  }
  assertSocketPath(options.socketPath);
  const socket = await (options.connect ?? connectUnixSocket)(options.socketPath);
  try {
    await writeAdmission(socket, options.admission);
    await Promise.all([
      pipeline(options.input, socket),
      pipeline(socket, options.output, { end: false }),
    ]);
  } finally {
    socket.destroy();
  }
}
