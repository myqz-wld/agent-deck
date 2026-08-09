import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { HostHello } from '@contracts/index';
import type { LengthPrefixedJsonDecoder } from '@protocol/frame';
import type { HostProtocolMessage } from '@protocol/messages';

import type { BoundedFrameWriter } from './frame-writer';
import type { SshChildRetirement } from './child-lifecycle';

type Timer = ReturnType<typeof setTimeout>;

export interface ConnectionContext {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  retirement: SshChildRetirement;
  decoder: LengthPrefixedJsonDecoder;
  writer: BoundedFrameWriter;
  helloRequestId: string;
  handshakeComplete: boolean;
  handshakeTimer: Timer | null;
  detachListeners: (() => void) | null;
  stderr: string;
  hostKeyFailure: boolean;
  terminated: boolean;
}

export interface ConnectDeferred {
  promise: Promise<HostHello>;
  resolve: (hello: HostHello) => void;
  reject: (error: Error) => void;
}

export function createConnectDeferred(): ConnectDeferred {
  let resolve!: (hello: HostHello) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<HostHello>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export interface SshProtocolConnectionHooks {
  getEventCursor(): number;
  onReady(hello: HostHello, reconnected: boolean): void;
  onMessage(message: HostProtocolMessage): void;
  onTerminal(error: Error): void;
}
