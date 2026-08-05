import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';

import type {
  HostInstanceLeasePort,
  HostInstanceLock,
} from '../types';
import { LinuxHostAdapterError } from './errors';

export interface FlockLeaseOptions {
  readonly lockRoot: string;
  readonly flockExecutable?: string;
  readonly holderExecutable?: string;
  readonly releaseTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Test-only fallback for kernels without a traversable /proc/self/fd. */
  readonly testOnlyDirectPaths?: boolean;
}

export type FlockSpawn = typeof spawn;

interface HeldLock {
  readonly lock: HostInstanceLock;
  readonly child: ChildProcessWithoutNullStreams;
  lost: boolean;
}

function validateToken(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) {
    throw new LinuxHostAdapterError('lock_failed', `${field} was rejected`);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new LinuxHostAdapterError('lock_failed', 'Lock holder did not retire'));
    }, timeoutMs);
    timer.unref();
    const onExit = (code: number | null): void => {
      cleanup();
      resolve(code);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

/** Holds util-linux flock through a pipe-bound cat child; parent death closes the pipe and lock. */
export class FlockHostInstanceLeasePort implements HostInstanceLeasePort {
  private readonly flockExecutable: string;
  private readonly holderExecutable: string;
  private readonly releaseTimeoutMs: number;
  private readonly held = new Map<string, HeldLock>();

  constructor(
    private readonly options: FlockLeaseOptions,
    private readonly spawnProcess: FlockSpawn = spawn,
  ) {
    if ((options.platform ?? process.platform) !== 'linux') {
      throw new LinuxHostAdapterError('platform_unsupported', 'Host locks require Linux');
    }
    if (
      !posix.isAbsolute(options.lockRoot) || posix.normalize(options.lockRoot) !== options.lockRoot ||
      options.lockRoot === '/' || options.lockRoot.includes('\0')
    ) throw new LinuxHostAdapterError('lock_failed', 'Host lock root was rejected');
    this.flockExecutable = options.flockExecutable ?? '/usr/bin/flock';
    this.holderExecutable = options.holderExecutable ?? '/usr/bin/cat';
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? 5_000;
  }

  private async openRoot(): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.options.lockRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const identity = await handle.stat();
      const resolved = await realpath(
        this.options.testOnlyDirectPaths
          ? this.options.lockRoot
          : `/proc/self/fd/${handle.fd}`,
      );
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (
        !identity.isDirectory() ||
        (identity.mode & 0o777) !== 0o700 ||
        (uid !== null && identity.uid !== uid) ||
        resolved !== this.options.lockRoot
      ) throw new Error('unsafe root');
      return handle;
    } catch (error) {
      await handle?.close();
      throw new LinuxHostAdapterError('trust_failed', 'Host lock root is unsafe');
    }
  }

  private validateExecutables(): void {
    for (const executable of [this.flockExecutable, this.holderExecutable]) {
      if (!posix.isAbsolute(executable) || posix.normalize(executable) !== executable) {
        throw new LinuxHostAdapterError('lock_failed', 'Host lock executable was rejected');
      }
    }
  }

  private validateReleaseTimeout(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new LinuxHostAdapterError('lock_failed', 'Lock release timeout was rejected');
    }
  }

  async acquire(input: {
    readonly key: string;
    readonly ownerToken: string;
    readonly timeoutMs: number;
  }): Promise<HostInstanceLock> {
    validateToken(input.key, 'lock key');
    validateToken(input.ownerToken, 'owner token');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 600_000) {
      throw new LinuxHostAdapterError('lock_failed', 'Lock timeout was rejected');
    }
    this.validateExecutables();
    const root = await this.openRoot();
    const filename = `${createHash('sha256').update(input.key).digest('hex')}.lock`;
    const lockPath = this.options.testOnlyDirectPaths
      ? posix.join(this.options.lockRoot, filename)
      : `/proc/self/fd/${root.fd}/${filename}`;
    const marker = `${randomUUID()}\n`;
    let lockFile: FileHandle;
    try {
      lockFile = await open(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
    } finally {
      await root.close();
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      const file = await lockFile.stat();
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (!file.isFile() || (file.mode & 0o777) !== 0o600 || (uid !== null && file.uid !== uid)) {
        throw new LinuxHostAdapterError('trust_failed', 'Host lock file is unsafe');
      }
      const spawned = this.spawnProcess(this.flockExecutable, [
        '--exclusive',
        '--wait',
        (input.timeoutMs / 1000).toFixed(3),
        '--',
        '/proc/self/fd/3',
        this.holderExecutable,
      ], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', lockFile.fd],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
      if (!spawned.stdin || !spawned.stdout || !spawned.stderr) {
        try { spawned.kill('SIGKILL'); } catch {}
        throw new LinuxHostAdapterError('lock_failed', 'Host lock holder pipes are unavailable');
      }
      child = spawned as ChildProcessWithoutNullStreams;
    } finally {
      await lockFile.close();
    }
    const acquired = await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderrBytes = 0;
      const timer = setTimeout(() => fail(), input.timeoutMs + 1_000);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onStderr);
        child.off('error', fail);
        child.off('exit', fail);
      };
      const fail = (): void => {
        cleanup();
        try { child.kill('SIGKILL'); } catch {}
        reject(new LinuxHostAdapterError('lock_failed', 'Exact host lock could not be acquired'));
      };
      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8');
        if (stdout === marker) {
          cleanup();
          resolve();
        } else if (stdout.length >= marker.length || !marker.startsWith(stdout)) fail();
      };
      const onStderr = (chunk: Buffer): void => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > 4_096) fail();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onStderr);
      child.once('error', fail);
      child.once('exit', fail);
      child.stdin.write(marker);
    });
    void acquired;
    const lock: HostInstanceLock = Object.freeze({
      key: input.key,
      ownerToken: input.ownerToken,
      lockId: randomUUID(),
      acquiredAtMs: Date.now(),
    });
    const held: HeldLock = { lock, child, lost: false };
    this.held.set(lock.lockId, held);
    if (child.exitCode !== null || child.signalCode !== null) held.lost = true;
    child.once('exit', () => {
      if (this.held.get(lock.lockId) === held) held.lost = true;
    });
    return lock;
  }

  async release(lock: HostInstanceLock, timeoutMs: number): Promise<void> {
    this.validateReleaseTimeout(timeoutMs);
    const held = this.held.get(lock.lockId);
    if (
      !held ||
      held.lock !== lock ||
      held.lock.key !== lock.key ||
      held.lock.ownerToken !== lock.ownerToken
    ) {
      throw new LinuxHostAdapterError('lock_failed', 'Host lock ownership did not match');
    }
    this.held.delete(lock.lockId);
    held.child.stdin.end();
    let exitCode: number | null;
    try {
      exitCode = await waitForExit(
        held.child,
        Math.min(timeoutMs, this.releaseTimeoutMs),
      );
    } catch (error) {
      try { held.child.kill('SIGKILL'); } catch {}
      throw error;
    }
    if (held.lost || exitCode !== 0) {
      throw new LinuxHostAdapterError('lock_failed', 'Host lock holder exited unexpectedly');
    }
  }

  async quarantine(lock: unknown, timeoutMs: number): Promise<void> {
    const lockId = lock && typeof lock === 'object' && 'lockId' in lock
      ? (lock as { lockId?: unknown }).lockId
      : null;
    if (typeof lockId !== 'string') return;
    const held = this.held.get(lockId);
    if (!held) return;
    this.held.delete(lockId);
    held.child.stdin.end();
    try {
      await waitForExit(held.child, Math.min(timeoutMs, this.releaseTimeoutMs));
    } catch {
      try { held.child.kill('SIGKILL'); } catch {}
    }
  }
}
