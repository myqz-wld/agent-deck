import { createConnection, type Socket } from 'node:net';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';

import type { GrokAcpSessionFactory } from '@main/adapters/grok-build/acp-process';
import { ProviderSessionSupervisorTransportClient } from '@hosts/provider-session';
import type { ProviderSessionInferenceTransport } from '@hosts/provider-session';

import {
  ServerCoreProviderGrokContainerRuntime,
  type ServerCoreProviderGrokContainerReadiness,
  type ServerCoreProviderGrokContainerRuntimeOptions,
} from './provider-grok-container-runtime';
import { createServerCoreProviderGrokContainerTransport } from './provider-grok-container-transport';
import {
  createProductionServerCoreProviderInference,
  type ProductionServerCoreProviderInferenceOptions,
} from './provider-inference-production';

export interface ProductionServerCoreProviderGrokContainerOptions
  extends ProductionServerCoreProviderInferenceOptions {
  readonly inferenceTransport?: ProviderSessionInferenceTransport;
  readonly instanceId: string;
  readonly onInferenceFailure?: ServerCoreProviderGrokContainerRuntimeOptions['onInferenceFailure'];
  readonly projectTrusted: (cwd: string) => Promise<boolean>;
  readonly supervisorSocketPath: string;
}

export interface ProductionServerCoreProviderGrokContainer {
  configureBrowserRelay(
    relay: ServerCoreProviderGrokContainerRuntimeOptions['browserRelay'],
  ): void;
  readonly processFactory: GrokAcpSessionFactory;
  readonly runtime: ServerCoreProviderGrokContainerRuntime;
  close(): Promise<void>;
  readiness(): Promise<ServerCoreProviderGrokContainerReadiness>;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

function identity(stat: Stats): PathIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    uid: stat.uid,
  });
}

function same(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid;
}

function currentUid(options: ProductionServerCoreProviderGrokContainerOptions): number {
  const uid = (options.currentUid ?? (() =>
    typeof process.getuid === 'function' ? process.getuid() : -1))();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('provider container Core owner is invalid');
  }
  return uid;
}

function privateDirectory(path: string, uid: number, field: string): PathIdentity {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0') ||
      realpathSync(path) !== path) {
    throw new Error(`${field} is invalid`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${field} is not private`);
  }
  return identity(stat);
}

function socketIdentity(path: string, uid: number): PathIdentity {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600) {
    throw new Error('provider supervisor socket is not private');
  }
  return identity(stat);
}

function within(parent: string, child: string): boolean {
  const relationPath = relative(parent, child);
  return relationPath === '' || (
    relationPath !== '..' && !relationPath.startsWith(`..${sep}`) && !isAbsolute(relationPath)
  );
}

function connectPrivate(
  path: string,
  root: string,
  rootIdentity: PathIdentity,
  uid: number,
): Socket {
  if (!same(rootIdentity, privateDirectory(root, uid, 'provider supervisor socket root'))) {
    throw new Error('provider supervisor socket root identity changed');
  }
  const before = socketIdentity(path, uid);
  const socket = createConnection(path);
  socket.once('connect', () => {
    try {
      if (!same(before, socketIdentity(path, uid)) ||
          !same(rootIdentity, privateDirectory(root, uid, 'provider supervisor socket root'))) {
        socket.destroy(new Error('provider supervisor socket identity changed'));
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error('provider supervisor socket failed'));
    }
  });
  return socket;
}

/** Production Core-side composition. The OCI engine remains behind the private host socket. */
export function createProductionServerCoreProviderGrokContainer(
  options: ProductionServerCoreProviderGrokContainerOptions,
): ProductionServerCoreProviderGrokContainer {
  const uid = currentUid(options);
  const socketPath = options.supervisorSocketPath;
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || socketPath === '/' ||
      socketPath.includes('\0') || Buffer.byteLength(socketPath) > 103) {
    throw new Error('provider supervisor socket path is invalid');
  }
  const socketRoot = dirname(socketPath);
  const rootIdentity = privateDirectory(socketRoot, uid, 'provider supervisor socket root');
  if (within(options.workspaceRoot, socketRoot) || within(socketRoot, options.workspaceRoot) ||
      within(options.credentialRoot, socketRoot) || within(socketRoot, options.credentialRoot)) {
    throw new Error('provider supervisor socket root overlaps an untrusted or credential root');
  }
  const supervisor = new ProviderSessionSupervisorTransportClient({
    connect: () => connectPrivate(socketPath, socketRoot, rootIdentity, uid),
    socketPath,
  });
  const inference = createProductionServerCoreProviderInference(options);
  const runtime = new ServerCoreProviderGrokContainerRuntime({
    inference,
    inferenceTransport: options.inferenceTransport ?? (
      process.platform === 'darwin' ? 'stdio-multiplex-v1' : 'unix-http-v1'
    ),
    instanceId: options.instanceId,
    onInferenceFailure: options.onInferenceFailure,
    supervisor,
  });
  const processFactory = createServerCoreProviderGrokContainerTransport({
    projectTrusted: options.projectTrusted,
    runtime,
    workspaceRoot: options.workspaceRoot,
  });
  return Object.freeze({
    configureBrowserRelay: (relay) => runtime.setBrowserRelay(relay),
    processFactory,
    runtime,
    close: () => runtime.close(),
    readiness: () => runtime.readiness(),
  });
}
