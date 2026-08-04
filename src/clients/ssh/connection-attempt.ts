import type { ClientHello, JsonValue } from '@contracts/index';
import { LengthPrefixedJsonDecoder } from '@protocol/frame';

import { buildOpenSshArgv } from './argv';
import type { ResolvedSshTransportOptions } from './config';
import { SshChildRetirement } from './child-lifecycle';
import type { ConnectionContext } from './connection-context';
import { SshTransportError } from './errors';
import { BoundedFrameWriter } from './frame-writer';
import type { SpawnSshProcess, SshHostProfile } from './types';

export interface ConnectionAttemptHooks {
  adopt(retirement: SshChildRetirement): void;
  activate(context: ConnectionContext): void;
  createId(): string;
  onStdout(context: ConnectionContext, chunk: unknown): void;
  onStderr(context: ConnectionContext, chunk: unknown): void;
  onFailure(context: ConnectionContext, error: unknown): void;
}

export interface ConnectionAttemptInput {
  profile: Readonly<SshHostProfile>;
  spawn: SpawnSshProcess;
  resolved: ResolvedSshTransportOptions;
  generation: number;
  hello: ClientHello;
  hooks: ConnectionAttemptHooks;
}

export function startConnectionAttempt(input: ConnectionAttemptInput): ConnectionContext {
  const child = input.spawn(
    input.profile.sshBinary ?? 'ssh',
    buildOpenSshArgv(input.profile),
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const retirement = new SshChildRetirement(child, input.resolved.timing);
  input.hooks.adopt(retirement);
  let context!: ConnectionContext;
  let writer: BoundedFrameWriter | null = null;
  try {
    const helloRequestId = input.hooks.createId();
    writer = new BoundedFrameWriter(
      child.stdin,
      {
        maxFrameBytes: input.resolved.bounds.maxFrameBytes,
        maxQueuedBytes: input.resolved.bounds.maxQueuedWriteBytes,
        maxQueuedFrames: input.resolved.bounds.maxQueuedWriteFrames,
      },
      (error) => input.hooks.onFailure(context, error),
    );
    context = {
      generation: input.generation,
      child,
      retirement,
      decoder: new LengthPrefixedJsonDecoder(input.resolved.bounds.maxFrameBytes),
      writer,
      helloRequestId,
      handshakeComplete: false,
      handshakeTimer: null,
      detachListeners: null,
      stderr: '',
      hostKeyFailure: false,
      terminated: false,
    };
    input.hooks.activate(context);
    const onStdout = (chunk: unknown): void => input.hooks.onStdout(context, chunk);
    const onStdoutError = (error: Error): void => input.hooks.onFailure(context, error);
    const onStderr = (chunk: unknown): void => input.hooks.onStderr(context, chunk);
    const onStderrError = (error: Error): void => input.hooks.onFailure(context, error);
    const onChildError = (error: Error): void => input.hooks.onFailure(context, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (context.terminated) return;
      input.hooks.onFailure(
        context,
        new SshTransportError(
          'connection_failed',
          `SSH bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
          true,
        ),
      );
    };
    context.detachListeners = () => {
      child.stdout.off('data', onStdout);
      child.stdout.off('error', onStdoutError);
      child.stderr.off('data', onStderr);
      child.stderr.off('error', onStderrError);
      child.off('error', onChildError);
      child.off('exit', onExit);
      context.detachListeners = null;
    };
    child.stdout.on('data', onStdout);
    child.stdout.on('error', onStdoutError);
    child.stderr.on('data', onStderr);
    child.stderr.on('error', onStderrError);
    child.once('error', onChildError);
    child.once('exit', onExit);
    context.handshakeTimer = setTimeout(
      () =>
        input.hooks.onFailure(
          context,
          new SshTransportError('handshake_timeout', 'SSH protocol handshake timed out', true),
        ),
      input.resolved.timing.handshakeTimeoutMs,
    );
    writer.enqueue({
      type: 'hello',
      requestId: context.helloRequestId,
      hello: input.hello,
    } as unknown as JsonValue);
  } catch (error) {
    writer?.close();
    throw error;
  }
  return context;
}
