import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
  type ProviderSessionLaunchResult,
  type ProviderSessionLaunchSpec,
  type ProviderSessionSupervisorCapabilities,
} from '@contracts/index';
import { UnixSocketDaemonListener, type DaemonListener } from '@hosts/daemon';

import type { ProviderSessionSupervisorControlPort } from './supervisor-port';
import {
  PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
  parseProviderSessionSupervisorTransportResponse,
} from './supervisor-transport-contract';
import { ProviderSessionSupervisorTransportClient } from './supervisor-transport-client';
import {
  readProviderSessionSupervisorFrame,
  writeProviderSessionSupervisorFrame,
} from './supervisor-transport-frame';
import { ProviderSessionSupervisorTransportServer } from './supervisor-transport-server';

const roots: string[] = [];
const servers: ProviderSessionSupervisorTransportServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launch(): ProviderSessionLaunchSpec {
  return {
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    adapterId: 'grok-build',
    brokerEndpointId: 'endpoint-a',
    effectiveAccess: 'selected-directory-read-write',
    launchId: 'launch-a',
    processId: 'process-a',
    providerId: 'xai',
    resourceClass: 'interactive-v1',
    runtimeId: 'grok-build-v1',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    workingDirectory: 'repo',
  };
}

function capabilities(): ProviderSessionSupervisorCapabilities {
  return {
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    adapterIds: ['grok-build'],
    available: true,
    disabledReason: null,
    generation: 1,
  };
}

function fakeSupervisor(overrides: Partial<ProviderSessionSupervisorControlPort> = {}) {
  const readCapabilities: ProviderSessionSupervisorControlPort['capabilities'] =
    async () => capabilities();
  const start: ProviderSessionSupervisorControlPort['launch'] = async (spec) => ({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    launchId: spec.launchId,
    processId: spec.processId,
    runtimeHandle: 'runtime-a',
    sessionId: spec.sessionId,
  });
  const stop: ProviderSessionSupervisorControlPort['stop'] = async (spec) => ({
    ...spec,
    stopped: true,
  });
  const base: ProviderSessionSupervisorControlPort = {
    attach: vi.fn(async () => {
      const stream = new PassThrough();
      return {
        stream,
        exited: new Promise<never>(() => undefined),
        close: async () => { stream.destroy(); },
      };
    }),
    capabilities: vi.fn(readCapabilities),
    launch: vi.fn(start),
    stop: vi.fn(stop),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return base;
}

async function harness(supervisor = fakeSupervisor()) {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, 'adp-')));
  roots.push(root);
  const socketPath = join(root, 's.sock');
  const server = new ProviderSessionSupervisorTransportServer({
    listener: new UnixSocketDaemonListener(socketPath, root),
    supervisor,
  });
  await server.start();
  servers.push(server);
  return {
    client: new ProviderSessionSupervisorTransportClient({
      nextRequestId: () => 'request-a',
      socketPath,
    }),
    server,
    socketPath,
    supervisor,
  };
}

function connected(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('Provider session supervisor private transport', () => {
  it('claims the private listener before reconciling stale containers', async () => {
    const order: string[] = [];
    const listener: DaemonListener = {
      start: vi.fn(async () => { order.push('listener'); }),
      stop: vi.fn(async () => undefined),
    };
    const prepare = vi.fn(async () => { order.push('prepare'); });
    const server = new ProviderSessionSupervisorTransportServer({
      listener,
      prepare,
      supervisor: fakeSupervisor(),
    });
    servers.push(server);

    await server.start();

    expect(order).toEqual(['listener', 'prepare']);
  });

  it('does not reconcile containers when another supervisor owns the listener', async () => {
    const listener: DaemonListener = {
      start: vi.fn(async () => { throw new Error('socket in use'); }),
      stop: vi.fn(async () => undefined),
    };
    const prepare = vi.fn(async () => undefined);
    const supervisor = fakeSupervisor();
    const server = new ProviderSessionSupervisorTransportServer({
      listener,
      prepare,
      supervisor,
    });

    await expect(server.start()).rejects.toThrow('socket in use');

    expect(prepare).not.toHaveBeenCalled();
    expect(listener.stop).not.toHaveBeenCalled();
    expect(supervisor.close).toHaveBeenCalledOnce();
  });

  it('round-trips only exact topology-free capabilities, launch, stop, and close calls', async () => {
    const { client, server, supervisor } = await harness();
    await expect(client.capabilities()).resolves.toEqual(capabilities());
    const started = await client.launch(launch());
    await expect(client.stop({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      processId: started.processId,
      runtimeHandle: started.runtimeHandle,
      sessionId: started.sessionId,
    })).resolves.toMatchObject({ stopped: true });
    await client.close();
    await expect(server.whenCloseRequested()).resolves.toBeUndefined();

    expect(supervisor.launch).toHaveBeenCalledWith(launch());
    expect(JSON.stringify(vi.mocked(supervisor.launch).mock.calls)).not.toMatch(
      /engine|executable|image|mount|credential|hostPath/i,
    );
    expect(supervisor.close).toHaveBeenCalledOnce();
  });

  it('upgrades one exact attach request into opaque bidirectional container stdio', async () => {
    const coreToHost = new PassThrough();
    const hostToCore = new PassThrough();
    const attachedStream = Duplex.from({ readable: hostToCore, writable: coreToHost });
    let exit!: (value: { code: number; signal: null }) => void;
    const exited = new Promise<{ code: number; signal: null }>((resolve) => { exit = resolve; });
    const close = vi.fn(async () => {
      attachedStream.destroy();
      exit({ code: 0, signal: null });
    });
    const supervisor = fakeSupervisor({
      attach: vi.fn(async () => ({ stream: attachedStream, exited, close })),
    });
    const { client } = await harness(supervisor);
    const channel = await client.attach({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
    });
    const receivedByHost = new Promise<string>((resolve) => {
      coreToHost.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    channel.stream.write(Buffer.from('{"method":"initialize"}\n'));
    await expect(receivedByHost).resolves.toBe('{"method":"initialize"}\n');

    const receivedByCore = new Promise<string>((resolve) => {
      channel.stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    hostToCore.write(Buffer.from('{"result":"ready"}\n'));
    await expect(receivedByCore).resolves.toBe('{"result":"ready"}\n');
    await channel.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(supervisor.attach).toHaveBeenCalledWith({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
    });
  });

  it('preserves an ACP frame that arrives before attach returns a consumer', async () => {
    const coreToHost = new PassThrough();
    const hostToCore = new PassThrough();
    hostToCore.write(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    const attachedStream = Duplex.from({ readable: hostToCore, writable: coreToHost });
    const supervisor = fakeSupervisor({
      attach: vi.fn(async () => ({
        stream: attachedStream,
        exited: new Promise<never>(() => undefined),
        close: async () => { attachedStream.destroy(); },
      })),
    });
    const { client } = await harness(supervisor);
    const channel = await client.attach({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
    });

    const firstFrame = await new Promise<string>((resolve) => {
      channel.stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    expect(firstFrame).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await channel.close();
  });

  it('drops widened or multi-frame requests before supervisor dispatch', async () => {
    const { socketPath, supervisor } = await harness();
    const socket = await connected(socketPath);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(`${JSON.stringify({
      schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
      method: 'launch',
      params: { ...launch(), engineSocket: '/var/run/docker.sock' },
      requestId: 'launch:launch-a',
    })}\n{}\n`);
    await closed;
    expect(supervisor.launch).not.toHaveBeenCalled();
  });

  it('replays an in-flight launch after the first response connection is abandoned', async () => {
    let resolveLaunch!: (value: ProviderSessionLaunchResult) => void;
    let started!: () => void;
    const launchStarted = new Promise<void>((resolve) => { started = resolve; });
    const start: ProviderSessionSupervisorControlPort['launch'] = () => {
      started();
      return new Promise<ProviderSessionLaunchResult>((resolve) => { resolveLaunch = resolve; });
    };
    const supervisor = fakeSupervisor({
      launch: vi.fn(start),
    });
    const { socketPath } = await harness(supervisor);
    const request = {
      schemaVersion: PROVIDER_SESSION_SUPERVISOR_TRANSPORT_VERSION,
      method: 'launch' as const,
      params: launch(),
      requestId: 'launch:launch-a',
    };
    const first = await connected(socketPath);
    await writeProviderSessionSupervisorFrame(first, request);
    await launchStarted;
    first.destroy();

    const second = await connected(socketPath);
    await writeProviderSessionSupervisorFrame(second, request);
    resolveLaunch({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      launchId: 'launch-a',
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
    });
    const response = parseProviderSessionSupervisorTransportResponse(
      await readProviderSessionSupervisorFrame(second, 1_000),
      'launch',
      request.requestId,
    );
    expect(response.ok && response.result).toMatchObject({ runtimeHandle: 'runtime-a' });
    expect(supervisor.launch).toHaveBeenCalledOnce();
    second.destroy();
  });
});
