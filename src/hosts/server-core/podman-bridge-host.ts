import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  PodmanBridgeStreamOptions,
  ServerCorePodmanHostPort,
} from './podman-bridge';

interface DeadlineWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface PodmanBridgeDeadlinePort {
  wait(delayMs: number): DeadlineWait;
}

export interface PodmanBridgeHostDependencies {
  readonly platform: NodeJS.Platform;
  readonly getUid: () => number;
  readonly spawnProcess: typeof spawn;
  readonly deadlines: PodmanBridgeDeadlinePort;
}

type Terminal =
  | { readonly kind: 'exit'; readonly code: number | null }
  | { readonly kind: 'error' };

type Drain =
  | { readonly kind: 'drained' }
  | { readonly kind: 'error' };

const CAPTURE_TIMEOUT_MS = 5_000;
const INPUT_EXIT_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 2_000;
const FINAL_EXIT_WAIT_MS = 2_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const SYSTEM_DEADLINES: PodmanBridgeDeadlinePort = Object.freeze({
  wait(delayMs: number): DeadlineWait {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, delayMs);
    });
    return Object.freeze({
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    });
  },
});

const PRODUCTION_DEPENDENCIES: PodmanBridgeHostDependencies = Object.freeze({
  platform: process.platform,
  getUid: () => typeof process.getuid === 'function' ? process.getuid() : 0,
  spawnProcess: spawn,
  deadlines: SYSTEM_DEADLINES,
});

function assertArgv(args: readonly string[]): void {
  if (
    args.length === 0 || args.length > 32 ||
    args.some((argument) => !argument || argument.includes('\0') || Buffer.byteLength(argument) > 4096)
  ) {
    throw new Error('Podman argv was rejected');
  }
}

function observeChild(child: ChildProcessWithoutNullStreams): {
  readonly terminal: Promise<Terminal>;
  readonly drain: Promise<Drain>;
  cleanup(): void;
} {
  let onError!: () => void;
  let onExit!: (code: number | null) => void;
  let onClose!: () => void;
  let resolveDrain!: (state: Drain) => void;
  let drainSettled = false;
  const terminal = new Promise<Terminal>((resolve) => {
    onError = () => {
      resolve({ kind: 'error' });
      settleDrain({ kind: 'error' });
    };
    onExit = (code) => resolve({ kind: 'exit', code });
    child.once('error', onError);
    child.once('exit', onExit);
  });
  const drain = new Promise<Drain>((resolve) => { resolveDrain = resolve; });
  function settleDrain(state: Drain): void {
    if (drainSettled) return;
    drainSettled = true;
    resolveDrain(state);
  }
  onClose = () => settleDrain({ kind: 'drained' });
  child.once('close', onClose);

  let remainingPipes = 2;
  const pipeCleanups: Array<() => void> = [];
  for (const pipe of [child.stdout, child.stderr]) {
    let pipeSettled = false;
    const onTerminal = (): void => {
      if (pipeSettled) return;
      pipeSettled = true;
      remainingPipes -= 1;
      if (remainingPipes === 0) settleDrain({ kind: 'drained' });
    };
    const onPipeError = (): void => settleDrain({ kind: 'error' });
    pipe.once('end', onTerminal);
    pipe.once('close', onTerminal);
    pipe.once('error', onPipeError);
    pipeCleanups.push(() => {
      pipe.removeListener('end', onTerminal);
      pipe.removeListener('close', onTerminal);
      pipe.removeListener('error', onPipeError);
    });
  }

  return {
    terminal,
    drain,
    cleanup: () => {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      for (const cleanup of pipeCleanups) cleanup();
    },
  };
}

export class NodeServerCorePodmanHost implements ServerCorePodmanHostPort {
  private readonly environment: Readonly<Record<string, string>>;

  constructor(private readonly dependencies: PodmanBridgeHostDependencies) {
    const uid = dependencies.getUid();
    if (dependencies.platform !== 'linux' || !Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error('Server Core Podman bridge requires one rootless Linux service account');
    }
    this.environment = Object.freeze({
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      HOME: '/var/lib/agent-deck',
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
    });
  }

  private spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    assertArgv(args);
    try {
      return this.dependencies.spawnProcess('/usr/bin/podman', [...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.environment,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      throw new Error('Rootless Podman operation could not start');
    }
  }

  private async bounded<T>(
    operation: Promise<T>,
    delayMs: number,
    cancellation?: Promise<unknown>,
  ): Promise<T | null> {
    const deadline = this.dependencies.deadlines.wait(delayMs);
    try {
      return await Promise.race([
        operation,
        deadline.promise.then(() => null),
        ...(cancellation ? [cancellation.then(() => null)] : []),
      ]);
    } finally {
      deadline.cancel();
    }
  }

  private async terminate(
    child: ChildProcessWithoutNullStreams,
    terminal: Promise<Terminal>,
  ): Promise<Terminal | null> {
    try { child.kill('SIGTERM'); } catch {}
    let result = await this.bounded(terminal, TERMINATE_GRACE_MS);
    if (result) return result;
    try { child.kill('SIGKILL'); } catch {}
    result = await this.bounded(terminal, FINAL_EXIT_WAIT_MS);
    if (!result) child.unref();
    return result;
  }

  async capture(args: readonly string[]): Promise<string> {
    const child = this.spawn(args);
    const observation = observeChild(child);
    child.stdin.end();
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const onStdout = (chunk: Buffer): void => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(Buffer.from(chunk));
    };
    const onStderr = (chunk: Buffer): void => { stderrBytes += chunk.byteLength; };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    let terminal = await this.bounded(observation.terminal, CAPTURE_TIMEOUT_MS);
    const timedOut = terminal === null;
    if (timedOut || terminal?.kind === 'error') {
      terminal = await this.terminate(child, observation.terminal);
    }
    let drain: Drain | null = null;
    if (terminal?.kind === 'exit') {
      drain = await this.bounded(observation.drain, FINAL_EXIT_WAIT_MS);
      if (!drain) child.unref();
    }
    observation.cleanup();
    child.stdout.removeListener('data', onStdout);
    child.stderr.removeListener('data', onStderr);
    child.stdout.destroy();
    child.stderr.destroy();
    if (
      timedOut || !terminal || terminal.kind !== 'exit' || terminal.code !== 0 ||
      !drain || drain.kind !== 'drained' ||
      stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes !== 0
    ) {
      throw new Error('Rootless Podman inspection failed');
    }
    return Buffer.concat(stdout).toString('utf8');
  }

  async stream(args: readonly string[], options: PodmanBridgeStreamOptions): Promise<void> {
    const child = this.spawn(args);
    const observation = observeChild(child);
    let stderrBytes = 0;
    const stderrSink = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        stderrBytes += chunk.byteLength;
        callback(stderrBytes > MAX_STDERR_BYTES ? new Error('bounded stderr exceeded') : undefined);
      },
    });
    const input = pipeline(options.input, child.stdin);
    const output = pipeline(child.stdout, options.output, { end: false });
    const errors = pipeline(child.stderr, stderrSink);
    let onAbort!: () => void;
    const aborted = new Promise<'abort'>((resolve) => {
      onAbort = () => resolve('abort');
      if (options.signal?.aborted) resolve('abort');
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const first = await Promise.race([
      observation.terminal.then((terminal) => ({ kind: 'terminal' as const, terminal })),
      input.then(
        () => ({ kind: 'input-end' as const }),
        () => ({ kind: 'pipe-error' as const }),
      ),
      output.then(
        () => ({ kind: 'output-end' as const }),
        () => ({ kind: 'pipe-error' as const }),
      ),
      errors.then(
        () => ({ kind: 'stderr-end' as const }),
        () => ({ kind: 'pipe-error' as const }),
      ),
      aborted.then(() => ({ kind: 'abort' as const })),
    ]);
    let terminal = first.kind === 'terminal' ? first.terminal : null;
    if (first.kind === 'input-end') {
      terminal = await this.bounded(observation.terminal, INPUT_EXIT_TIMEOUT_MS, aborted);
    } else if (first.kind === 'output-end' || first.kind === 'stderr-end') {
      terminal = await this.bounded(observation.terminal, FINAL_EXIT_WAIT_MS, aborted);
    }
    const forcedTermination = terminal === null || terminal.kind === 'error';
    if (forcedTermination) terminal = await this.terminate(child, observation.terminal);
    const drained = await this.bounded(
      Promise.allSettled([input, output, errors]),
      FINAL_EXIT_WAIT_MS,
    );
    const drainFailed = drained?.some((result) => result.status === 'rejected') ?? false;
    options.signal?.removeEventListener('abort', onAbort);
    observation.cleanup();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    stderrSink.destroy();
    if (
      !terminal || terminal.kind !== 'exit' || terminal.code !== 0 ||
      first.kind === 'pipe-error' || first.kind === 'abort' ||
      forcedTermination || drainFailed || stderrBytes !== 0
    ) {
      throw new Error('Server Core bridge process failed');
    }
  }
}

export function createProductionServerCorePodmanHost(): ServerCorePodmanHostPort {
  return new NodeServerCorePodmanHost(PRODUCTION_DEPENDENCIES);
}
