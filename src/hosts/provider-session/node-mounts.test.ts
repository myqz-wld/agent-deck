import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderSessionLaunchSpec } from '@contracts/index';

import { NodeProviderSessionMounts } from './node-mounts';
import { providerSessionBrokerSocketPath } from './broker-socket-path';

interface Fixture {
  readonly brokerRoot: string;
  readonly manager: NodeProviderSessionMounts;
  readonly privateRoot: string;
  readonly root: string;
  readonly socketPath: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spec(overrides: Partial<ProviderSessionLaunchSpec> = {}): ProviderSessionLaunchSpec {
  return {
    schemaVersion: 1,
    adapterId: 'grok-build',
    brokerEndpointId: 'broker-a',
    effectiveAccess: 'selected-directory-read-write',
    launchId: 'launch-a',
    processId: 'process-a',
    providerId: 'xai',
    resourceClass: 'interactive-v1',
    runtimeId: 'grok-build-v1',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    workingDirectory: 'repo',
    ...overrides,
  };
}

async function listen(path: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return server;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'agent-deck-pm-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const privateRoot = join(root, 'private');
  const stateRoot = join(privateRoot, 'session-state');
  const brokerRoot = join(privateRoot, 'broker');
  for (const path of [workspaceRoot, privateRoot, stateRoot, brokerRoot]) {
    mkdirSync(path, { mode: 0o700 });
  }
  mkdirSync(join(workspaceRoot, 'repo'), { mode: 0o700 });
  const socketPath = providerSessionBrokerSocketPath(brokerRoot, 'broker-a');
  await listen(socketPath);
  return {
    brokerRoot,
    manager: new NodeProviderSessionMounts({
      brokerRoot,
      privateRoot,
      stateRoot,
      workspaceRoot,
    }),
    privateRoot,
    root,
    socketPath,
    stateRoot,
    workspaceRoot,
  };
}

describe('NodeProviderSessionMounts', () => {
  it('derives only exact Workspace, private state, and broker socket mounts', async () => {
    const state = await fixture();
    const binding = await state.manager.capture(spec());
    expect(binding).toMatchObject({
      brokerSocketPath: state.socketPath,
      selectedDirectory: join(state.workspaceRoot, 'repo'),
      workspaceRoot: state.workspaceRoot,
    });
    expect(binding.stateDirectory.startsWith(`${state.stateRoot}/session-`)).toBe(true);
    for (const child of ['cache', 'config', 'home', 'state']) {
      expect(existsSync(join(binding.stateDirectory, child))).toBe(true);
    }
    await expect(state.manager.revalidate(binding)).resolves.toBeUndefined();
  });

  it('omits the host Unix socket from Desktop-VM mount authority', async () => {
    const state = await fixture();
    const manager = new NodeProviderSessionMounts({
      brokerRoot: state.brokerRoot,
      inferenceTransport: 'stdio-multiplex-v1',
      privateRoot: state.privateRoot,
      stateRoot: state.stateRoot,
      workspaceRoot: state.workspaceRoot,
    });
    const binding = await manager.capture(spec());
    expect(binding.brokerSocketPath).toBeNull();
    await expect(manager.revalidate(binding)).resolves.toBeUndefined();
    await manager.release(binding);
  });

  it('removes only exact temporary state and does not follow model-created symlinks', async () => {
    const state = await fixture();
    const binding = await state.manager.capture(spec());
    const outside = join(state.root, 'outside-canary');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(binding.stateDirectory, 'home', 'outside-link'));
    await state.manager.release(binding);
    expect(existsSync(binding.stateDirectory)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(state.workspaceRoot)).toBe(true);
    expect(existsSync(state.socketPath)).toBe(true);
  });

  it('detects selected-directory and broker-socket identity replacement', async () => {
    const selected = await fixture();
    const selectedBinding = await selected.manager.capture(spec());
    renameSync(join(selected.workspaceRoot, 'repo'), join(selected.workspaceRoot, 'repo-old'));
    mkdirSync(join(selected.workspaceRoot, 'repo'), { mode: 0o700 });
    await expect(selected.manager.revalidate(selectedBinding)).rejects.toThrow('identity changed');
    await selected.manager.release(selectedBinding);

    const broker = await fixture();
    const brokerBinding = await broker.manager.capture(spec());
    const server = servers.find((candidate) => candidate.listening &&
      candidate.address() === broker.socketPath);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await expect(broker.manager.revalidate(brokerBinding)).rejects.toThrow();
    await broker.manager.release(brokerBinding);
  });

  it('rejects symlink directories, non-private sockets, and widened binding objects', async () => {
    const state = await fixture();
    symlinkSync(join(state.workspaceRoot, 'repo'), join(state.workspaceRoot, 'linked-repo'));
    await expect(state.manager.capture(spec({ workingDirectory: 'linked-repo' }))).rejects.toThrow();
    chmodSync(state.socketPath, 0o666);
    await expect(state.manager.capture(spec())).rejects.toThrow('private');
    chmodSync(state.socketPath, 0o600);
    const binding = await state.manager.capture(spec());
    await expect(state.manager.revalidate({ ...binding, extra: true } as never)).rejects.toThrow();
    await state.manager.release(binding);
  });

  it('rejects duplicate state identity and unsafe private-root permissions', async () => {
    const state = await fixture();
    const binding = await state.manager.capture(spec());
    await expect(state.manager.capture(spec())).rejects.toThrow('capture failed');
    await state.manager.release(binding);

    chmodSync(state.privateRoot, 0o755);
    expect(() => new NodeProviderSessionMounts({
      brokerRoot: state.brokerRoot,
      privateRoot: state.privateRoot,
      stateRoot: state.stateRoot,
      workspaceRoot: state.workspaceRoot,
    })).toThrow('private');
  });
});
