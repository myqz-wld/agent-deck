import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { Duplex } from 'node:stream';

import type {
  ProviderSessionOciAttachment,
  ProviderSessionOciAttachmentExit,
} from './types';

export interface ProviderSessionAttachmentProcessRequest {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly startupTimeoutMs: number;
}

export interface ProviderSessionAttachmentProcessPort {
  open(request: ProviderSessionAttachmentProcessRequest): Promise<ProviderSessionOciAttachment>;
}

export interface NodeProviderSessionAttachmentProcessOptions {
  readonly finalExitWaitMs?: number;
  readonly terminateGraceMs?: number;
}

const MAX_TERMINATION_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;
const ALLOWED_ENVIRONMENT = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'DOCKER_HOST',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'XDG_RUNTIME_DIR',
]);
const FORBIDDEN_ENVIRONMENT = /^(?:BASH_ENV|DYLD_.*|ENV|LD_.*|NODE_OPTIONS)$/;

function validate(request: ProviderSessionAttachmentProcessRequest): void {
  if (!isAbsolute(request.executable) || normalize(request.executable) !== request.executable ||
      request.executable === '/' || request.executable.includes('\0') ||
      request.args.length < 3 || request.args.length > 128 ||
      !Number.isSafeInteger(request.startupTimeoutMs) || request.startupTimeoutMs < 1 ||
      request.startupTimeoutMs > 30_000) {
    throw new Error('provider OCI attachment request was rejected');
  }
  for (const argument of request.args) {
    if (!argument || argument.includes('\0') || Buffer.byteLength(argument) > 4_096) {
      throw new Error('provider OCI attachment argv was rejected');
    }
  }
  const entries = Object.entries(request.environment);
  if (entries.length > 16) throw new Error('provider OCI attachment environment was rejected');
  for (const [key, value] of entries) {
    if (!ALLOWED_ENVIRONMENT.has(key) || FORBIDDEN_ENVIRONMENT.test(key) ||
        value.includes('\0') || Buffer.byteLength(value) > 8_192) {
      throw new Error('provider OCI attachment environment was rejected');
    }
  }
}

function boundedDelay(delayMs: number): {
  readonly promise: Promise<false>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), delayMs);
    timer.unref();
  });
  return Object.freeze({
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}

async function bounded<T>(operation: Promise<T>, delayMs: number): Promise<T | false> {
  const deadline = boundedDelay(delayMs);
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    deadline.cancel();
  }
}

class NodeProviderSessionOciAttachment implements ProviderSessionOciAttachment {
  readonly exited: Promise<ProviderSessionOciAttachmentExit>;
  readonly stream: Duplex;
  private closePromise: Promise<void> | null = null;
  private stderrBytes = 0;
  private stderrChunks: Buffer[] = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly terminateGraceMs: number,
    private readonly finalExitWaitMs: number,
  ) {
    this.stream = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    this.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (value: ProviderSessionOciAttachmentExit): void => {
        if (settled) return;
        settled = true;
        resolve(Object.freeze(value));
      };
      child.once('exit', (code, signal) => finish({ code, signal }));
      child.once('error', () => finish({ code: null, signal: null }));
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() => finish({ code: child.exitCode, signal: child.signalCode }));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => this.collectStderr(chunk));
    void this.exited.then(() => this.stream.destroy());
  }

  get diagnostics(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8').trim();
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private collectStderr(chunk: Buffer): void {
    const remaining = Math.max(0, MAX_STDERR_BYTES - this.stderrBytes);
    if (remaining > 0) {
      const selected = chunk.subarray(0, remaining);
      this.stderrChunks.push(Buffer.from(selected));
      this.stderrBytes += selected.byteLength;
    }
    if (chunk.byteLength > remaining) void this.close();
  }

  private async closeOnce(): Promise<void> {
    try { this.stream.end(); } catch {}
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (await bounded(this.exited, this.terminateGraceMs)) return;
    try { this.child.kill('SIGTERM'); } catch {}
    if (await bounded(this.exited, this.terminateGraceMs)) return;
    try { this.child.kill('SIGKILL'); } catch {}
    if (!(await bounded(this.exited, this.finalExitWaitMs))) {
      this.stream.destroy();
      this.child.unref();
      throw new Error('provider OCI attachment exceeded its terminal bound');
    }
  }
}

/** Shell-free streaming runner for one fixed `container attach` command. */
export class NodeProviderSessionAttachmentProcess
implements ProviderSessionAttachmentProcessPort {
  private readonly finalExitWaitMs: number;
  private readonly terminateGraceMs: number;

  constructor(
    options: NodeProviderSessionAttachmentProcessOptions = {},
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    this.terminateGraceMs = options.terminateGraceMs ?? 2_000;
    this.finalExitWaitMs = options.finalExitWaitMs ?? 2_000;
    for (const value of [this.terminateGraceMs, this.finalExitWaitMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TERMINATION_MS) {
        throw new Error('provider OCI attachment termination bound is invalid');
      }
    }
  }

  async open(
    request: ProviderSessionAttachmentProcessRequest,
  ): Promise<ProviderSessionOciAttachment> {
    validate(request);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(request.executable, [...request.args], {
        env: { ...request.environment },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new Error('provider OCI attachment could not start');
    }
    const started = new Promise<true>((resolve, reject) => {
      child.once('spawn', () => resolve(true));
      child.once('error', reject);
    });
    try {
      if (!(await bounded(started, request.startupTimeoutMs))) {
        try { child.kill('SIGTERM'); } catch {}
        throw new Error('provider OCI attachment startup timed out');
      }
      return new NodeProviderSessionOciAttachment(
        child,
        this.terminateGraceMs,
        this.finalExitWaitMs,
      );
    } catch (error) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      throw error;
    }
  }
}
