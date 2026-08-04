import { Duplex } from 'node:stream';

import type {
  AuthenticatedClientAccessContext,
  ClientHello,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import {
  CURRENT_PROTOCOL_VERSION,
  encodeJsonFrame,
  LengthPrefixedJsonDecoder,
} from '@protocol/index';

import { DaemonHost } from './host';
import { resolveDaemonInstancePaths } from './instance-paths';
import type { DaemonCoreRuntime } from './types';

export class TestDuplex extends Duplex {
  readonly writes: Buffer[] = [];
  private blockWrites = false;
  private readonly writeCallbacks: Array<(error?: Error | null) => void> = [];

  constructor(writableHighWaterMark = 1) {
    super({ writableHighWaterMark });
  }

  _read(): void {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    if (this.blockWrites) this.writeCallbacks.push(callback);
    else callback();
  }

  feed(value: JsonValue): void {
    this.push(Buffer.from(encodeJsonFrame(value)));
  }

  feedBytes(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }

  feedMany(values: JsonValue[]): void {
    this.push(Buffer.concat(values.map((value) => Buffer.from(encodeJsonFrame(value)))));
  }

  decoded(): JsonValue[] {
    return new LengthPrefixedJsonDecoder().push(Buffer.concat(this.writes));
  }

  setWriteBlocked(blocked: boolean): void {
    this.blockWrites = blocked;
    if (!blocked) {
      for (const callback of this.writeCallbacks.splice(0)) callback();
    }
  }
}

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function hello(clientId: string, requestedTopology = 'server-core'): JsonObject {
  return {
    type: 'hello',
    requestId: `hello-${clientId}`,
    hello: {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      appVersion: 'desktop-test',
      clientId,
      requestedTopology,
    },
  };
}

export function request(requestId: string, method = 'system.health'): JsonObject {
  return {
    type: 'request',
    requestId,
    method,
    params: {},
    idempotencyKey: null,
    expectedRevision: null,
    deadlineAt: null,
  };
}

export function sshAccess(clientHello: ClientHello): AuthenticatedClientAccessContext {
  return {
    kind: 'authenticated-client',
    topology: 'server-core',
    instanceId: 'tenant-a',
    clientId: clientHello.clientId,
    transport: 'ssh',
    accessCredentialId: 'ssh-credential-1',
    authority: 'owner-equivalent',
    surface: 'desktop-full',
  };
}

export function createRuntime(
  overrides: Partial<DaemonCoreRuntime> = {},
): DaemonCoreRuntime {
  return {
    supportedMethods: ['system.health'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 0,
    execute: async () => ({ result: { ok: true }, revision: 0 }),
    ...overrides,
  };
}

export function createHost(
  runtime: DaemonCoreRuntime,
  limits = {},
  now?: () => number,
): DaemonHost {
  return new DaemonHost({
    paths: resolveDaemonInstancePaths('tenant-a', {
      HOME: '/srv/agent-deck',
      XDG_RUNTIME_DIR: '/run/user/1200',
    }),
    appVersion: '0.1.0-test',
    runtime,
    listener: null,
    connectionLimits: limits,
    sqlitePreflight: () => ({ runtimeAbi: 'test' }),
    now,
  });
}

export function findMessage(
  stream: TestDuplex,
  type: string,
  requestId?: string,
): JsonObject | undefined {
  return stream.decoded().find(
    (value): value is JsonObject =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      value.type === type &&
      (requestId === undefined || value.requestId === requestId),
  );
}
