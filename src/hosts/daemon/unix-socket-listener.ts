import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, normalize } from 'node:path';

import type { DaemonListener } from './types';

export type DaemonSocketErrorCode =
  | 'invalid_existing_path'
  | 'runtime_directory_unsafe'
  | 'socket_in_use'
  | 'socket_owner_mismatch'
  | 'socket_probe_failed';

export class DaemonSocketError extends Error {
  constructor(
    readonly code: DaemonSocketErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DaemonSocketError';
  }
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface PathStats extends SocketIdentity {
  readonly uid: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
}

export interface UnixSocketListenerDependencies {
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly lstat: (path: string) => Promise<PathStats>;
  readonly mkdir: (
    path: string,
    options: { recursive: true; mode: number },
  ) => Promise<unknown>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly unlink: (path: string) => Promise<void>;
  readonly createConnection: (path: string) => Socket;
  readonly createServer: (listener: (socket: Socket) => void) => Server;
  readonly getuid: () => number | null;
}

const DEFAULT_DEPENDENCIES: UnixSocketListenerDependencies = {
  chmod,
  lstat,
  mkdir,
  realpath,
  unlink,
  createConnection,
  createServer,
  getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readSocketIdentity(
  socketPath: string,
  dependencies: UnixSocketListenerDependencies,
): Promise<SocketIdentity | null> {
  try {
    const stats = await dependencies.lstat(socketPath);
    if (!stats.isSocket()) {
      throw new DaemonSocketError(
        'invalid_existing_path',
        `Refusing to replace non-socket path: ${socketPath}`,
      );
    }
    const uid = dependencies.getuid();
    if (uid !== null && stats.uid !== uid) {
      throw new DaemonSocketError(
        'socket_owner_mismatch',
        `Refusing to replace Unix socket owned by uid ${stats.uid}`,
      );
    }
    return { dev: stats.dev, ino: stats.ino, mode: stats.mode };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function preparePrivateRuntimeDirectory(
  runtimeDirectory: string,
  dependencies: UnixSocketListenerDependencies,
): Promise<void> {
  await dependencies.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const before = await dependencies.lstat(runtimeDirectory);
  const uid = dependencies.getuid();
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (uid !== null && before.uid !== uid) ||
    (dependencies.realpath && (await dependencies.realpath(runtimeDirectory)) !== runtimeDirectory)
  ) {
    throw new DaemonSocketError(
      'runtime_directory_unsafe',
      `Runtime directory must be an owned real directory: ${runtimeDirectory}`,
    );
  }
  await dependencies.chmod(runtimeDirectory, 0o700);
  const after = await dependencies.lstat(runtimeDirectory);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    (after.mode & 0o777) !== 0o700 ||
    (dependencies.realpath && (await dependencies.realpath(runtimeDirectory)) !== runtimeDirectory)
  ) {
    throw new DaemonSocketError(
      'runtime_directory_unsafe',
      `Runtime directory changed or remained non-private: ${runtimeDirectory}`,
    );
  }
}

async function probeExistingSocket(
  socketPath: string,
  dependencies: UnixSocketListenerDependencies,
): Promise<'active' | 'stale'> {
  return await new Promise((resolve, reject) => {
    const socket = dependencies.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new DaemonSocketError(
          'socket_probe_failed',
          `Timed out while probing existing Unix socket: ${socketPath}`,
        ),
      );
    }, 250);
    timeout.unref();

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve('active');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve('stale');
      else reject(new DaemonSocketError('socket_probe_failed', error.message, error));
    });
  });
}

async function removeVerifiedStaleSocket(
  socketPath: string,
  dependencies: UnixSocketListenerDependencies,
): Promise<void> {
  const before = await readSocketIdentity(socketPath, dependencies);
  if (!before) return;
  if ((await probeExistingSocket(socketPath, dependencies)) === 'active') {
    throw new DaemonSocketError('socket_in_use', `Unix socket is already accepting: ${socketPath}`);
  }
  const after = await readSocketIdentity(socketPath, dependencies);
  if (!after) return;
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new DaemonSocketError(
      'socket_probe_failed',
      `Unix socket changed while checking staleness: ${socketPath}`,
    );
  }
  await dependencies.unlink(socketPath);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
        } else if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
      } else {
        reject(error);
      }
    }
  });
}

async function unlinkOwnedSocket(
  socketPath: string,
  ownedIdentity: SocketIdentity,
  dependencies: UnixSocketListenerDependencies,
): Promise<void> {
  const current = await readSocketIdentity(socketPath, dependencies);
  if (
    current &&
    current.dev === ownedIdentity.dev &&
    current.ino === ownedIdentity.ino
  ) {
    await dependencies.unlink(socketPath);
  }
}

export class UnixSocketDaemonListener implements DaemonListener {
  private server: Server | null = null;
  private socketIdentity: SocketIdentity | null = null;
  private runtimeErrorHandler: ((error: Error) => void) | null = null;
  private failureValue: Error | null = null;
  private readonly failureWaiters: Array<(error: Error) => void> = [];

  constructor(
    readonly socketPath: string,
    readonly runtimeDirectory: string,
    private readonly dependencies: UnixSocketListenerDependencies = DEFAULT_DEPENDENCIES,
  ) {
    if (
      normalize(socketPath) !== socketPath ||
      normalize(runtimeDirectory) !== runtimeDirectory ||
      socketPath.includes('\u0000') ||
      runtimeDirectory.includes('\u0000') ||
      dirname(socketPath) !== runtimeDirectory
    ) {
      throw new DaemonSocketError(
        'runtime_directory_unsafe',
        'Unix socket must be a normalized direct child of its runtime directory',
      );
    }
  }

  get failure(): Error | null {
    return this.failureValue;
  }

  whenFailed(): Promise<Error> {
    if (this.failureValue) return Promise.resolve(this.failureValue);
    return new Promise((resolve) => this.failureWaiters.push(resolve));
  }

  async start(
    onConnection: (stream: Socket) => void,
    onFailure?: (error: Error) => void,
  ): Promise<void> {
    if (this.server) throw new Error('Unix socket listener is already started');
    this.failureValue = null;
    await preparePrivateRuntimeDirectory(this.runtimeDirectory, this.dependencies);
    await removeVerifiedStaleSocket(this.socketPath, this.dependencies);

    const server = this.dependencies.createServer((socket) => {
      try {
        onConnection(socket);
      } catch {
        socket.destroy();
      }
    });
    this.server = server;
    let createdIdentity: SocketIdentity | null = null;
    const onRuntimeError = (error: Error): void => {
      if (this.server !== server || this.failureValue) return;
      this.failureValue = error;
      for (const resolve of this.failureWaiters.splice(0)) resolve(error);
      try {
        onFailure?.(error);
      } catch {
        // A supervisor callback cannot turn a handled listener failure into an uncaught error.
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(this.socketPath, () => {
          server.off('error', onError);
          server.on('error', onRuntimeError);
          this.runtimeErrorHandler = onRuntimeError;
          resolve();
        });
      });
      createdIdentity = await readSocketIdentity(this.socketPath, this.dependencies);
      if (!createdIdentity) {
        throw new DaemonSocketError(
          'runtime_directory_unsafe',
          `Unix socket disappeared after listen: ${this.socketPath}`,
        );
      }
      await this.dependencies.chmod(this.socketPath, 0o600);
      const verifiedIdentity = await readSocketIdentity(this.socketPath, this.dependencies);
      if (
        !verifiedIdentity ||
        verifiedIdentity.dev !== createdIdentity.dev ||
        verifiedIdentity.ino !== createdIdentity.ino ||
        (verifiedIdentity.mode & 0o777) !== 0o600
      ) {
        throw new DaemonSocketError(
          'runtime_directory_unsafe',
          `Unix socket did not become mode 0600: ${this.socketPath}`,
        );
      }
      if (this.failureValue) throw this.failureValue;
      this.socketIdentity = verifiedIdentity;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      let serverClosed = false;
      try {
        await closeServer(server);
        serverClosed = true;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (serverClosed) {
        this.server = null;
        server.off('error', onRuntimeError);
        this.runtimeErrorHandler = null;
      } else {
        this.server = server;
      }
      this.socketIdentity = createdIdentity;
      if (serverClosed && createdIdentity) {
        try {
          await unlinkOwnedSocket(this.socketPath, createdIdentity, this.dependencies);
          this.socketIdentity = null;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          'Unix socket listener startup and cleanup failed',
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server) {
      this.server = null;
      try {
        await closeServer(server);
      } catch (error) {
        this.server = server;
        throw error;
      }
      if (this.runtimeErrorHandler) server.off('error', this.runtimeErrorHandler);
      this.runtimeErrorHandler = null;
    }

    const ownedIdentity = this.socketIdentity;
    if (!ownedIdentity) return;
    await unlinkOwnedSocket(this.socketPath, ownedIdentity, this.dependencies);
    this.socketIdentity = null;
  }
}
