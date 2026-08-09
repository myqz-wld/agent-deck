import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

import type {
  CommandPort,
  CommandRequest,
  CommandResult,
  FileIdentity,
  TrustedFileArtifact,
} from '../types';
import { LinuxHostAdapterError } from './errors';

export interface LinuxCommandRunnerOptions {
  readonly terminateGraceMs?: number;
  readonly finalExitWaitMs?: number;
  readonly platform?: NodeJS.Platform;
}

export type LinuxCommandSpawn = typeof spawn;

export interface CommandDeadlineWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface CommandDeadlinePort {
  wait(delayMs: number): CommandDeadlineWait;
}

const SYSTEM_DEADLINES: CommandDeadlinePort = Object.freeze({
  wait(delayMs: number): CommandDeadlineWait {
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

const ALLOWED_ENVIRONMENT = new Set([
  'AGENT_DECK_EGRESS_ENFORCEMENT',
  'AGENT_DECK_VOLUME_QUOTA_READY',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'XDG_RUNTIME_DIR',
]);
const FORBIDDEN_ENVIRONMENT = new Set([
  'BASH_ENV',
  'ENV',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
]);
const MAX_TERMINATION_PHASE_MS = 30_000;

function sameIdentity(stat: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>, expected: FileIdentity): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.mode === expected.mode &&
    stat.uid === expected.uid &&
    stat.size === expected.size &&
    stat.mtimeMs === expected.modifiedAtMs &&
    stat.isFile() &&
    expected.kind === 'file'
  );
}

async function openVerifiedArtifact(artifact: TrustedFileArtifact): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      artifact.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!sameIdentity(before, artifact.identity)) throw new Error('artifact changed');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const digest = createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
    if (
      offset !== before.size ||
      !sameIdentity(after, artifact.identity) ||
      digest !== artifact.sha256
    ) {
      throw new Error('artifact changed');
    }
  } catch (error) {
    await handle?.close();
    throw new LinuxHostAdapterError(
      'trust_failed',
      'Trusted command artifact did not match its exact fence',
    );
  }
  return handle;
}

async function verifyArtifact(artifact: TrustedFileArtifact): Promise<void> {
  const handle = await openVerifiedArtifact(artifact);
  try {
    return;
  } finally {
    await handle?.close();
  }
}

function validateEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (
      FORBIDDEN_ENVIRONMENT.has(key) ||
      !ALLOWED_ENVIRONMENT.has(key) ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 8_192
    ) {
      throw new LinuxHostAdapterError('command_failed', 'Command environment was rejected');
    }
    if (
      (key === 'HOME' || key === 'XDG_RUNTIME_DIR') &&
      (!isAbsolute(value) || normalize(value) !== value || value === '/')
    ) {
      throw new LinuxHostAdapterError('command_failed', 'Command environment was rejected');
    }
    if (
      key === 'DBUS_SESSION_BUS_ADDRESS' &&
      !/^unix:path=\/run\/user\/[1-9][0-9]*\/bus$/.test(value)
    ) {
      throw new LinuxHostAdapterError('command_failed', 'Command environment was rejected');
    }
  }
}

function validate(request: CommandRequest): void {
  if (
    !isAbsolute(request.executable) ||
    normalize(request.executable) !== request.executable ||
    request.executable === '/' ||
    request.executable.includes('\0') ||
    request.args.length > 64 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 600_000 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > 16 * 1024 * 1024
  ) {
    throw new LinuxHostAdapterError('command_failed', 'Command request was rejected');
  }
  for (const argument of request.args) {
    if (!argument || argument.includes('\0') || Buffer.byteLength(argument) > 4_096) {
      throw new LinuxHostAdapterError('command_failed', 'Command argv was rejected');
    }
  }
  const artifacts = request.trustedArtifacts ?? [];
  if (artifacts.length > 32 || new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new LinuxHostAdapterError('command_failed', 'Trusted artifact set was rejected');
  }
  for (const artifact of artifacts) {
    if (
      !isAbsolute(artifact.path) || normalize(artifact.path) !== artifact.path ||
      artifact.path === '/' || artifact.path.includes('\0') ||
      artifact.identity.kind !== 'file' || artifact.identity.size < 0 ||
      artifact.identity.size > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) throw new LinuxHostAdapterError('command_failed', 'Trusted artifact fence was rejected');
  }
  validateEnvironment(request.environment ?? {});
}

type ChildTerminal =
  | { readonly kind: 'exit'; readonly code: number | null }
  | { readonly kind: 'error' };

type ChildDrain =
  | { readonly kind: 'drained' }
  | { readonly kind: 'error' };

function observeChild(child: ChildProcess): {
  readonly terminal: Promise<ChildTerminal>;
  readonly drain: Promise<ChildDrain>;
  cleanup(): void;
} {
  let onError!: () => void;
  let onExit!: (code: number | null) => void;
  let onClose!: () => void;
  let resolveDrain!: (state: ChildDrain) => void;
  let drainSettled = false;
  const terminal = new Promise<ChildTerminal>((resolve) => {
    onError = () => {
      resolve({ kind: 'error' });
      settleDrain({ kind: 'error' });
    };
    onExit = (code) => resolve({ kind: 'exit', code });
    child.once('error', onError);
    child.once('exit', onExit);
  });
  const drain = new Promise<ChildDrain>((resolve) => { resolveDrain = resolve; });
  function settleDrain(state: ChildDrain): void {
    if (drainSettled) return;
    drainSettled = true;
    resolveDrain(state);
  }
  onClose = () => settleDrain({ kind: 'drained' });
  child.once('close', onClose);

  const pipeCleanups: Array<() => void> = [];
  const pipes = [child.stdout, child.stderr]
    .filter((pipe): pipe is NonNullable<typeof pipe> => pipe !== null);
  let remainingPipes = pipes.length;
  const observePipe = (pipe: NodeJS.ReadableStream): void => {
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
  };
  for (const pipe of pipes) observePipe(pipe);
  if (remainingPipes === 0) settleDrain({ kind: 'drained' });

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

/** Shell-free, bounded-output runner with pre/post trusted-artifact identity and hash fences. */
export class LinuxBoundedCommandRunner implements CommandPort {
  private readonly terminateGraceMs: number;
  private readonly finalExitWaitMs: number;
  private readonly descriptorScripts: boolean;

  constructor(
    options: LinuxCommandRunnerOptions = {},
    private readonly spawnProcess: LinuxCommandSpawn = spawn,
    private readonly fixedEnvironment: Readonly<Record<string, string>> = {},
    private readonly deadlines: CommandDeadlinePort = SYSTEM_DEADLINES,
  ) {
    if ((options.platform ?? process.platform) !== 'linux') {
      throw new LinuxHostAdapterError('platform_unsupported', 'Linux command runner requires Linux');
    }
    this.descriptorScripts = process.platform === 'linux';
    this.terminateGraceMs = options.terminateGraceMs ?? 2_000;
    this.finalExitWaitMs = options.finalExitWaitMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.terminateGraceMs) || this.terminateGraceMs <= 0 ||
      this.terminateGraceMs > MAX_TERMINATION_PHASE_MS ||
      !Number.isSafeInteger(this.finalExitWaitMs) || this.finalExitWaitMs <= 0 ||
      this.finalExitWaitMs > MAX_TERMINATION_PHASE_MS
    ) {
      throw new RangeError('command termination bounds must be positive safe integers');
    }
    validateEnvironment(fixedEnvironment);
  }

  private async waitBounded<T>(
    operation: Promise<T>,
    delayMs: number,
  ): Promise<T | null> {
    const deadline = this.deadlines.wait(delayMs);
    try {
      return await Promise.race([
        operation,
        deadline.promise.then(() => null),
      ]);
    } finally {
      deadline.cancel();
    }
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    validate(request);
    for (const artifact of request.trustedArtifacts ?? []) await verifyArtifact(artifact);
    const args = [...request.args];
    const requestedEnvironment = request.environment ?? {};
    if (Object.keys(requestedEnvironment).some((key) => key in this.fixedEnvironment)) {
      throw new LinuxHostAdapterError('command_failed', 'Command environment was rejected');
    }
    const scriptArtifact = this.descriptorScripts
      ? (request.trustedArtifacts ?? []).find((artifact) => artifact.path === args[0])
      : undefined;
    const scriptHandle = scriptArtifact ? await openVerifiedArtifact(scriptArtifact) : undefined;
    if (scriptHandle) args[0] = '/proc/self/fd/3';
    let child: ChildProcess;
    try {
      child = this.spawnProcess(request.executable, args, {
        shell: false,
        stdio: scriptHandle
          ? ['ignore', 'pipe', 'pipe', scriptHandle.fd]
          : ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          ...this.fixedEnvironment,
          ...requestedEnvironment,
        },
      });
    } catch {
      throw new LinuxHostAdapterError('command_failed', 'Command could not start');
    } finally {
      await scriptHandle?.close();
    }
    let captured = 0;
    let outputTruncated = false;
    const collect = (chunk: Buffer, destination: Buffer[]): void => {
      const remaining = Math.max(0, request.maxOutputBytes - captured);
      if (chunk.byteLength > remaining) outputTruncated = true;
      if (remaining > 0) {
        const slice = chunk.subarray(0, remaining);
        destination.push(Buffer.from(slice));
        captured += slice.byteLength;
      }
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const onStdout = (chunk: Buffer): void => collect(chunk, stdout);
    const onStderr = (chunk: Buffer): void => collect(chunk, stderr);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    const observation = observeChild(child);
    let timedOut = false;
    let terminalState: ChildTerminal | null = null;
    let terminalBoundExceeded = false;
    let drainState: ChildDrain | null = null;
    let drainBoundExceeded = false;
    try {
      terminalState = await this.waitBounded(observation.terminal, request.timeoutMs);
      if (!terminalState) {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        terminalState = await this.waitBounded(observation.terminal, this.terminateGraceMs);
      }
      if (!terminalState) {
        try { child.kill('SIGKILL'); } catch {}
        terminalState = await this.waitBounded(observation.terminal, this.finalExitWaitMs);
      }
      terminalBoundExceeded = terminalState === null;
      if (terminalState?.kind === 'exit') {
        drainState = await this.waitBounded(observation.drain, this.finalExitWaitMs);
        drainBoundExceeded = drainState === null;
      }
    } finally {
      observation.cleanup();
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (terminalBoundExceeded) {
      child.unref();
      throw new LinuxHostAdapterError('command_failed', 'Command exceeded its terminal bound');
    }
    if (drainBoundExceeded) {
      child.unref();
      throw new LinuxHostAdapterError('command_failed', 'Command output exceeded its terminal drain bound');
    }
    if (terminalState?.kind === 'error') {
      throw new LinuxHostAdapterError('command_failed', 'Command could not start');
    }
    if (drainState?.kind === 'error') {
      throw new LinuxHostAdapterError('command_failed', 'Command output stream failed');
    }
    for (const artifact of request.trustedArtifacts ?? []) await verifyArtifact(artifact);
    return {
      exitCode: timedOut ? 124 : (terminalState?.code ?? 1),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      outputTruncated,
    };
  }
}
