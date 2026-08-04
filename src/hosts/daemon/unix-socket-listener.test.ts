import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UnixSocketDaemonListener,
  type UnixSocketListenerDependencies,
} from './unix-socket-listener';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-deck-daemon-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('private Unix socket listener', () => {
  it('creates mode-0700 runtime state and a mode-0600 private socket', async () => {
    let socketExists = false;
    let runtimeMode = 0o755;
    const chmodCalls: Array<[string, number]> = [];
    const unlink = vi.fn(async () => {
      socketExists = false;
    });
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      listen: vi.fn((_path: string, callback: () => void) => {
        socketExists = true;
        callback();
        return emitter as unknown as Server;
      }),
      close: vi.fn((callback?: (error?: Error) => void) => {
        callback?.();
        return emitter as unknown as Server;
      }),
    }) as unknown as Server;
    const missing = (): NodeJS.ErrnoException =>
      Object.assign(new Error('missing'), { code: 'ENOENT' });
    const dependencies: UnixSocketListenerDependencies = {
      chmod: async (path, mode) => {
        chmodCalls.push([path, mode]);
        if (path === runtimeDirectory) runtimeMode = mode;
      },
      mkdir: async () => undefined,
      lstat: async (path) => {
        if (path === runtimeDirectory) {
          return {
            dev: 1,
            ino: 1,
            uid: 501,
            mode: runtimeMode,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            isSocket: () => false,
          };
        }
        if (!socketExists) throw missing();
        return {
          dev: 1,
          ino: 2,
          uid: 501,
          mode: 0o600,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isSocket: () => true,
        };
      },
      unlink,
      createConnection: () => {
        throw new Error('clean socket path must not be probed');
      },
      createServer: (_callback: (socket: Socket) => void) => fakeServer,
      getuid: () => 501,
    };
    const runtimeDirectory = '/run/user/501/agent-deck/tenant-a';
    const socketPath = `${runtimeDirectory}/agent-deckd.sock`;
    const listener = new UnixSocketDaemonListener(
      socketPath,
      runtimeDirectory,
      dependencies,
    );
    await listener.start((socket) => socket.end());

    expect(chmodCalls).toEqual([
      [runtimeDirectory, 0o700],
      [socketPath, 0o600],
    ]);
    expect(fakeServer.listen).toHaveBeenCalledWith(socketPath, expect.any(Function));
    await listener.stop();
    expect(unlink).toHaveBeenCalledWith(socketPath);
  });

  it('awaits close and inode-safely removes its socket after post-listen verification fails', async () => {
    const runtimeDirectory = '/run/user/501/agent-deck/tenant-a';
    const socketPath = `${runtimeDirectory}/agent-deckd.sock`;
    let socketExists = false;
    let closeCompleted = false;
    const unlink = vi.fn(async () => {
      expect(closeCompleted).toBe(true);
      socketExists = false;
    });
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      listen: vi.fn((_path: string, callback: () => void) => {
        socketExists = true;
        callback();
        return emitter as unknown as Server;
      }),
      close: vi.fn((callback?: (error?: Error) => void) => {
        setImmediate(() => {
          closeCompleted = true;
          callback?.();
        });
        return emitter as unknown as Server;
      }),
    }) as unknown as Server;
    const missing = (): NodeJS.ErrnoException =>
      Object.assign(new Error('missing'), { code: 'ENOENT' });
    const dependencies: UnixSocketListenerDependencies = {
      chmod: async (path) => {
        if (path === socketPath) throw new Error('chmod verification failed');
      },
      mkdir: async () => undefined,
      lstat: async (path) => {
        if (path === runtimeDirectory) {
          return {
            dev: 1,
            ino: 1,
            uid: 501,
            mode: 0o700,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            isSocket: () => false,
          };
        }
        if (!socketExists) throw missing();
        return {
          dev: 1,
          ino: 2,
          uid: 501,
          mode: 0o755,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isSocket: () => true,
        };
      },
      unlink,
      createConnection: () => {
        throw new Error('clean socket path must not be probed');
      },
      createServer: () => fakeServer,
      getuid: () => 501,
    };
    const listener = new UnixSocketDaemonListener(
      socketPath,
      runtimeDirectory,
      dependencies,
    );

    await expect(listener.start(() => undefined)).rejects.toThrow(
      'chmod verification failed',
    );
    expect(closeCompleted).toBe(true);
    expect(unlink).toHaveBeenCalledWith(socketPath);
    expect(socketExists).toBe(false);
  });

  it('handles and exposes a post-start server error without an uncaught exception', async () => {
    const runtimeDirectory = '/run/user/501/agent-deck/tenant-a';
    const socketPath = `${runtimeDirectory}/agent-deckd.sock`;
    let socketExists = false;
    const emitter = new EventEmitter();
    const fakeServer = Object.assign(emitter, {
      listen: vi.fn((_path: string, callback: () => void) => {
        socketExists = true;
        callback();
        return emitter as unknown as Server;
      }),
      close: vi.fn((callback?: (error?: Error) => void) => {
        callback?.();
        return emitter as unknown as Server;
      }),
    }) as unknown as Server;
    const missing = (): NodeJS.ErrnoException =>
      Object.assign(new Error('missing'), { code: 'ENOENT' });
    const dependencies: UnixSocketListenerDependencies = {
      chmod: async () => undefined,
      mkdir: async () => undefined,
      lstat: async (path) => {
        if (path === runtimeDirectory) {
          return {
            dev: 1,
            ino: 1,
            uid: 501,
            mode: 0o700,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            isSocket: () => false,
          };
        }
        if (!socketExists) throw missing();
        return {
          dev: 1,
          ino: 2,
          uid: 501,
          mode: 0o600,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isSocket: () => true,
        };
      },
      unlink: async () => {
        socketExists = false;
      },
      createConnection: () => {
        throw new Error('clean socket path must not be probed');
      },
      createServer: () => fakeServer,
      getuid: () => 501,
    };
    const onFailure = vi.fn();
    const listener = new UnixSocketDaemonListener(
      socketPath,
      runtimeDirectory,
      dependencies,
    );
    const failureReported = listener.whenFailed();
    await listener.start(() => undefined, onFailure);

    const failure = new Error('runtime accept failure');
    expect(() => emitter.emit('error', failure)).not.toThrow();
    await expect(failureReported).resolves.toBe(failure);
    expect(listener.failure).toBe(failure);
    expect(onFailure).toHaveBeenCalledWith(failure);
    await listener.stop();
  });

  it('never replaces an existing regular file at the socket path', async () => {
    const root = await temporaryDirectory();
    const runtimeDirectory = join(root, 'runtime');
    const socketPath = join(runtimeDirectory, 'agent-deckd.sock');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(socketPath, 'canary', { flag: 'wx' });
    const listener = new UnixSocketDaemonListener(socketPath, runtimeDirectory);

    await expect(listener.start(() => undefined)).rejects.toMatchObject({
      code: 'invalid_existing_path',
    });
    expect(await readFile(socketPath, 'utf8')).toBe('canary');
  });

  it('rejects a symlinked runtime directory before chmod or listen', async () => {
    const root = await temporaryDirectory();
    const realDirectory = join(root, 'real-runtime');
    const runtimeDirectory = join(root, 'runtime-link');
    await mkdir(realDirectory);
    await symlink(realDirectory, runtimeDirectory);
    const listener = new UnixSocketDaemonListener(
      join(runtimeDirectory, 'agent-deckd.sock'),
      runtimeDirectory,
    );

    await expect(listener.start(() => undefined)).rejects.toMatchObject({
      code: 'runtime_directory_unsafe',
    });
  });
});
