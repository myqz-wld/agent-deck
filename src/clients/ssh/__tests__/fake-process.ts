import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { ClientHello, HostHello, JsonValue } from '@contracts/index';
import { AgentDeckCapability, isJsonObject } from '@contracts/index';
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from '@protocol/frame';

import type { SpawnSshProcess, StrictSshSpawnOptions } from '../types';

class FakeWritable extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  blocked = false;
  ended = false;
  autoCompleteWrites = true;
  private readonly callbacks: Array<() => void> = [];

  write(chunk: Uint8Array, callback?: () => void): boolean {
    this.writes.push(new Uint8Array(chunk));
    if (callback) {
      if (this.autoCompleteWrites) callback();
      else this.callbacks.push(callback);
    }
    return !this.blocked;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  drain(): void {
    this.emit('drain');
  }

  completeNextWrite(): void {
    this.callbacks.shift()?.();
  }
}

export class FakeSshProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  exitOnSigterm = true;
  exitOnSigkill = true;
  private readWriteIndex = 0;
  private exited = false;

  get hasExited(): boolean {
    return this.exited;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    if (this.exited) return false;
    if (
      (signal === 'SIGTERM' && this.exitOnSigterm) ||
      (signal === 'SIGKILL' && this.exitOnSigkill)
    ) {
      this.exit(null, typeof signal === 'string' ? signal : null);
    }
    return true;
  }

  emitMessage(value: JsonValue): void {
    this.stdout.write(encodeJsonFrame(value));
  }

  emitBytes(value: Uint8Array): void {
    this.stdout.write(value);
  }

  emitStderr(value: string): void {
    this.stderr.write(value);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  takeWrittenMessages(): JsonValue[] {
    const decoder = new LengthPrefixedJsonDecoder();
    const messages: JsonValue[] = [];
    for (; this.readWriteIndex < this.stdin.writes.length; this.readWriteIndex += 1) {
      messages.push(...decoder.push(this.stdin.writes[this.readWriteIndex]));
    }
    return messages;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

export interface SpawnCall {
  binary: string;
  argv: readonly string[];
  options: StrictSshSpawnOptions;
  process: FakeSshProcess;
}

export class FakeSpawnHarness {
  readonly calls: SpawnCall[] = [];

  readonly spawn: SpawnSshProcess = (binary, argv, options) => {
    const process = new FakeSshProcess();
    this.calls.push({ binary, argv: [...argv], options, process });
    return process.asChild();
  };

  get latest(): FakeSshProcess {
    const call = this.calls.at(-1);
    if (!call) throw new Error('No fake SSH process was spawned');
    return call.process;
  }
}

export function makeClientHello(
  clientId: string,
  topology: 'relay' | 'server-core' = 'server-core',
  lastEventRevision = 0,
): ClientHello {
  return {
    protocolVersion: { major: 1, minor: 0 },
    appVersion: '0.1.0-test',
    clientId,
    requestedTopology: topology,
    lastEventRevision,
  };
}

export function makeHostHello(
  clientId: string,
  topology: 'relay' | 'server-core' = 'server-core',
  overrides: Partial<HostHello> = {},
): HostHello {
  const relay = topology === 'relay';
  return {
    protocolVersion: { major: 1, minor: 0 },
    appVersion: '0.1.0-host',
    topology,
    instanceId: relay ? 'relay-a' : 'server-a',
    authoritativeCore: {
      id: relay ? 'worker-a' : 'core-a',
      location: relay ? 'local-worker' : 'server-appliance',
      generation: relay ? 1 : null,
    },
    access: {
      kind: 'authenticated-client',
      topology,
      instanceId: relay ? 'relay-a' : 'server-a',
      clientId,
      transport: 'ssh',
      accessCredentialId: `credential-${clientId}`,
      authority: 'owner-equivalent',
      surface: 'desktop-full',
    },
    capabilities: Object.values(AgentDeckCapability),
    limits: {
      maxFrameBytes: 1024 * 1024,
      maxBlobBytes: 4 * 1024 * 1024,
      maxConcurrentRequests: 8,
      maxQueuedEvents: 128,
    },
    eventRevision: 0,
    ...overrides,
  };
}

export function helloRequestId(process: FakeSshProcess): string {
  const hello = process.takeWrittenMessages().find(
    (message) => isJsonObject(message) && message.type === 'hello',
  );
  if (!isJsonObject(hello) || typeof hello.requestId !== 'string') {
    throw new Error('Missing client hello');
  }
  return hello.requestId;
}
