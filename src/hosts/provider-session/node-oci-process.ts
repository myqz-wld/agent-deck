import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

export interface ProviderSessionProcessRequest {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface ProviderSessionProcessResult {
  readonly exitCode: number | null;
  readonly outputTruncated: boolean;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ProviderSessionProcessPort {
  run(request: ProviderSessionProcessRequest): Promise<ProviderSessionProcessResult>;
}

interface DeadlineWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface ProviderSessionProcessDeadlinePort {
  wait(delayMs: number): DeadlineWait;
}

export interface NodeProviderSessionProcessOptions {
  readonly finalExitWaitMs?: number;
  readonly terminateGraceMs?: number;
}

const MAX_TERMINATION_MS = 30_000;
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
const decoder = new TextDecoder('utf-8', { fatal: true });

const SYSTEM_DEADLINES: ProviderSessionProcessDeadlinePort = Object.freeze({
  wait(delayMs: number): DeadlineWait {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, delayMs); });
    return Object.freeze({
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    });
  },
});

type Terminal =
  | { readonly kind: 'error' }
  | { readonly kind: 'exit'; readonly code: number | null };

type Drain = { readonly kind: 'drained' } | { readonly kind: 'error' };

function validate(request: ProviderSessionProcessRequest): void {
  if (!isAbsolute(request.executable) || normalize(request.executable) !== request.executable ||
      request.executable === '/' || request.executable.includes('\0') ||
      request.args.length === 0 || request.args.length > 128 ||
      !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 ||
      request.timeoutMs > 120_000 || !Number.isSafeInteger(request.maxOutputBytes) ||
      request.maxOutputBytes < 1 || request.maxOutputBytes > 16 * 1024 * 1024) {
    throw new Error('provider OCI process request was rejected');
  }
  for (const argument of request.args) {
    if (!argument || argument.includes('\0') || Buffer.byteLength(argument) > 4_096) {
      throw new Error('provider OCI process argv was rejected');
    }
  }
  const entries = Object.entries(request.environment);
  if (entries.length > 16) throw new Error('provider OCI process environment was rejected');
  for (const [key, value] of entries) {
    if (!ALLOWED_ENVIRONMENT.has(key) || FORBIDDEN_ENVIRONMENT.test(key) ||
        value.includes('\0') || Buffer.byteLength(value) > 8_192) {
      throw new Error('provider OCI process environment was rejected');
    }
  }
}

function observe(child: ChildProcess): {
  readonly terminal: Promise<Terminal>;
  readonly drain: Promise<Drain>;
  cleanup(): void;
} {
  let onError!: () => void;
  let onExit!: (code: number | null) => void;
  let onClose!: () => void;
  let resolveDrain!: (value: Drain) => void;
  let drainSettled = false;
  const settleDrain = (value: Drain): void => {
    if (drainSettled) return;
    drainSettled = true;
    resolveDrain(value);
  };
  const drain = new Promise<Drain>((resolve) => { resolveDrain = resolve; });
  const terminal = new Promise<Terminal>((resolve) => {
    onError = () => {
      resolve({ kind: 'error' });
      settleDrain({ kind: 'error' });
    };
    onExit = (code) => resolve({ kind: 'exit', code });
    child.once('error', onError);
    child.once('exit', onExit);
  });
  onClose = () => settleDrain({ kind: 'drained' });
  child.once('close', onClose);
  const cleanups: Array<() => void> = [];
  const pipes = [child.stdout, child.stderr]
    .filter((pipe): pipe is NonNullable<typeof pipe> => pipe !== null);
  let remaining = pipes.length;
  for (const pipe of pipes) {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      remaining -= 1;
      if (remaining === 0) settleDrain({ kind: 'drained' });
    };
    const fail = (): void => settleDrain({ kind: 'error' });
    pipe.once('end', finish);
    pipe.once('close', finish);
    pipe.once('error', fail);
    cleanups.push(() => {
      pipe.removeListener('end', finish);
      pipe.removeListener('close', finish);
      pipe.removeListener('error', fail);
    });
  }
  if (remaining === 0) settleDrain({ kind: 'drained' });
  return {
    terminal,
    drain,
    cleanup: () => {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/** Shell-free bounded child runner used only by the host-owned OCI adapter. */
export class NodeProviderSessionProcess implements ProviderSessionProcessPort {
  private readonly finalExitWaitMs: number;
  private readonly terminateGraceMs: number;

  constructor(
    options: NodeProviderSessionProcessOptions = {},
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly deadlines: ProviderSessionProcessDeadlinePort = SYSTEM_DEADLINES,
  ) {
    this.terminateGraceMs = options.terminateGraceMs ?? 2_000;
    this.finalExitWaitMs = options.finalExitWaitMs ?? 2_000;
    for (const value of [this.terminateGraceMs, this.finalExitWaitMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TERMINATION_MS) {
        throw new Error('provider OCI process termination bound is invalid');
      }
    }
  }

  async run(request: ProviderSessionProcessRequest): Promise<ProviderSessionProcessResult> {
    validate(request);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(request.executable, [...request.args], {
        env: { ...request.environment },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new Error('provider OCI process could not start');
    }
    const observation = observe(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let outputTruncated = false;
    const collect = (chunk: Buffer, destination: Buffer[]): void => {
      const remaining = Math.max(0, request.maxOutputBytes - captured);
      if (chunk.byteLength > remaining) {
        outputTruncated = true;
        try { child.kill('SIGTERM'); } catch {}
      }
      if (remaining > 0) {
        const selected = chunk.subarray(0, remaining);
        destination.push(Buffer.from(selected));
        captured += selected.byteLength;
      }
    };
    const onStdout = (chunk: Buffer): void => collect(chunk, stdout);
    const onStderr = (chunk: Buffer): void => collect(chunk, stderr);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    let terminal = await this.bounded(observation.terminal, request.timeoutMs);
    const timedOut = terminal === null;
    if (timedOut) {
      try { child.kill('SIGTERM'); } catch {}
      terminal = await this.bounded(observation.terminal, this.terminateGraceMs);
    }
    if (!terminal) {
      try { child.kill('SIGKILL'); } catch {}
      terminal = await this.bounded(observation.terminal, this.finalExitWaitMs);
    }
    let drain: Drain | null = null;
    if (terminal?.kind === 'exit') {
      drain = await this.bounded(observation.drain, this.finalExitWaitMs);
    }
    observation.cleanup();
    child.stdout?.removeListener('data', onStdout);
    child.stderr?.removeListener('data', onStderr);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (!terminal || !drain) {
      child.unref();
      throw new Error('provider OCI process exceeded its terminal bound');
    }
    if (terminal.kind === 'error' || drain.kind === 'error') {
      throw new Error('provider OCI process failed');
    }
    try {
      return Object.freeze({
        exitCode: timedOut ? 124 : terminal.code,
        outputTruncated,
        stderr: decoder.decode(Buffer.concat(stderr)),
        stdout: decoder.decode(Buffer.concat(stdout)),
        timedOut,
      });
    } catch {
      throw new Error('provider OCI process output was invalid');
    }
  }

  private async bounded<T>(operation: Promise<T>, delayMs: number): Promise<T | null> {
    const deadline = this.deadlines.wait(delayMs);
    try {
      return await Promise.race([operation, deadline.promise.then(() => null)]);
    } finally {
      deadline.cancel();
    }
  }
}
