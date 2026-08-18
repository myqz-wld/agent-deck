import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  parseProviderSessionLaunchSpec,
  type ProviderSessionLaunchSpec,
} from '@contracts/index';

import type {
  ProviderSessionHostMountBinding,
  ProviderSessionHostMountPort,
} from './types';
import { providerSessionBrokerSocketPath } from './broker-socket-path';

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

interface MountRecord {
  readonly binding: ProviderSessionHostMountBinding;
  readonly broker: PathIdentity | null;
  readonly browserBroker: PathIdentity | null;
  readonly selected: PathIdentity;
  readonly state: PathIdentity;
}

export interface NodeProviderSessionMountOptions {
  readonly brokerRoot: string;
  readonly currentUid?: () => number;
  readonly inferenceTransport?: 'stdio-multiplex-v1' | 'unix-http-v1';
  readonly privateRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const STATE_CHILDREN = Object.freeze(['cache', 'config', 'home', 'state']);

function normalizedAbsolute(value: string, field: string): string {
  if (
    !isAbsolute(value) || resolve(value) !== value || value === '/' || CONTROL.test(value) ||
    Buffer.byteLength(value) > 4_096
  ) throw new Error(`${field} must be one normalized private host path`);
  return value;
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function disjoint(left: string, right: string, field: string): void {
  if (within(left, right) || within(right, left)) {
    throw new Error(`${field} roots must be disjoint`);
  }
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

function canonicalDirectory(path: string, field: string): PathIdentity {
  normalizedAbsolute(path, field);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical directory`);
  }
  return identity(stat);
}

function canonicalSocket(path: string, field: string): PathIdentity {
  normalizedAbsolute(path, field);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical Unix socket`);
  }
  return identity(stat);
}

function assertPrivate(identityValue: PathIdentity, uid: number, field: string): void {
  if (identityValue.uid !== uid || (identityValue.mode & 0o077) !== 0) {
    throw new Error(`${field} must be owned by the supervisor and private`);
  }
}

function assertIdentity(path: string, expected: PathIdentity, kind: 'directory' | 'socket'): void {
  const actual = kind === 'directory'
    ? canonicalDirectory(path, 'provider mount directory')
    : canonicalSocket(path, 'provider mount socket');
  if (!same(actual, expected)) throw new Error('provider mount identity changed');
}

/** Exact host path authority for one already-provisioned Provider supervisor instance. */
export class NodeProviderSessionMounts implements ProviderSessionHostMountPort {
  private readonly brokerRoot: string;
  private readonly brokerRootIdentity: PathIdentity;
  private readonly currentUid: number;
  private readonly inferenceTransport: 'stdio-multiplex-v1' | 'unix-http-v1';
  private readonly privateRoot: string;
  private readonly privateRootIdentity: PathIdentity;
  private readonly records = new Map<string, MountRecord>();
  private readonly stateRoot: string;
  private readonly stateRootIdentity: PathIdentity;
  private readonly workspaceRoot: string;
  private readonly workspaceRootIdentity: PathIdentity;

  constructor(options: NodeProviderSessionMountOptions) {
    this.currentUid = (options.currentUid ?? (() => {
      if (typeof process.getuid !== 'function') throw new Error('provider mount owner is unavailable');
      return process.getuid();
    }))();
    this.inferenceTransport = options.inferenceTransport ?? 'unix-http-v1';
    if (!Number.isSafeInteger(this.currentUid) || this.currentUid < 0) {
      throw new Error('provider mount owner is invalid');
    }
    this.workspaceRoot = normalizedAbsolute(options.workspaceRoot, 'Provider Workspace');
    this.privateRoot = normalizedAbsolute(options.privateRoot, 'Provider private root');
    this.stateRoot = normalizedAbsolute(options.stateRoot, 'Provider state root');
    this.brokerRoot = normalizedAbsolute(options.brokerRoot, 'Provider broker root');
    this.workspaceRootIdentity = canonicalDirectory(this.workspaceRoot, 'Provider Workspace');
    this.privateRootIdentity = canonicalDirectory(this.privateRoot, 'Provider private root');
    this.stateRootIdentity = canonicalDirectory(this.stateRoot, 'Provider state root');
    this.brokerRootIdentity = canonicalDirectory(this.brokerRoot, 'Provider broker root');
    disjoint(this.workspaceRoot, this.privateRoot, 'Workspace and private');
    if (
      !within(this.privateRoot, this.stateRoot) || this.stateRoot === this.privateRoot ||
      !within(this.privateRoot, this.brokerRoot) || this.brokerRoot === this.privateRoot
    ) throw new Error('Provider mount roots must be exact private-root children');
    disjoint(this.stateRoot, this.brokerRoot, 'Provider state and broker');
    assertPrivate(this.privateRootIdentity, this.currentUid, 'Provider private root');
    assertPrivate(this.stateRootIdentity, this.currentUid, 'Provider state root');
    assertPrivate(this.brokerRootIdentity, this.currentUid, 'Provider broker root');
  }

  async capture(value: ProviderSessionLaunchSpec): Promise<ProviderSessionHostMountBinding> {
    const spec = parseProviderSessionLaunchSpec(value);
    this.assertRoots();
    const selectedDirectory = spec.workingDirectory === '.'
      ? this.workspaceRoot
      : resolve(this.workspaceRoot, ...spec.workingDirectory.split('/'));
    if (!within(this.workspaceRoot, selectedDirectory)) {
      throw new Error('Provider selected directory escapes the Workspace');
    }
    const selected = canonicalDirectory(selectedDirectory, 'Provider selected directory');
    const brokerSocketPath = this.inferenceTransport === 'unix-http-v1'
      ? providerSessionBrokerSocketPath(this.brokerRoot, spec.brokerEndpointId)
      : null;
    const broker = brokerSocketPath
      ? canonicalSocket(brokerSocketPath, 'Provider broker socket')
      : null;
    if (broker) assertPrivate(broker, this.currentUid, 'Provider broker socket');
    const browserBrokerSocketPath = spec.browserContext &&
      this.inferenceTransport === 'unix-http-v1'
      ? join(this.privateRoot, 'browser-cli', 'broker.sock')
      : null;
    const browserBroker = browserBrokerSocketPath
      ? canonicalSocket(browserBrokerSocketPath, 'Provider Browser broker socket')
      : null;
    if (browserBroker) {
      assertPrivate(browserBroker, this.currentUid, 'Provider Browser broker socket');
    }
    const digest = createHash('sha256').update([
      spec.launchId,
      spec.processId,
      spec.sessionId,
      spec.brokerEndpointId,
    ].join('\0')).digest('hex');
    const bindingId = `binding-${digest}`;
    const stateDirectory = join(this.stateRoot, `session-${digest.slice(0, 32)}`);
    let state: PathIdentity | null = null;
    try {
      mkdirSync(stateDirectory, { mode: 0o700 });
      state = canonicalDirectory(stateDirectory, 'Provider session state');
      assertPrivate(state, this.currentUid, 'Provider session state');
      for (const child of STATE_CHILDREN) mkdirSync(join(stateDirectory, child), { mode: 0o700 });
      const binding = Object.freeze({
        bindingId,
        browserBrokerSocketPath,
        brokerSocketPath,
        selectedDirectory,
        stateDirectory,
        workspaceRoot: this.workspaceRoot,
      });
      this.records.set(bindingId, Object.freeze({
        binding, broker, browserBroker, selected, state,
      }));
      return binding;
    } catch {
      if (state) this.removeStateExact(stateDirectory, state);
      throw new Error('Provider session mount capture failed');
    }
  }

  async revalidate(binding: ProviderSessionHostMountBinding): Promise<void> {
    const record = this.record(binding);
    this.assertRoots();
    assertIdentity(record.binding.selectedDirectory, record.selected, 'directory');
    if (record.binding.brokerSocketPath && record.broker) {
      assertIdentity(record.binding.brokerSocketPath, record.broker, 'socket');
    } else if (record.binding.brokerSocketPath !== null || record.broker !== null) {
      throw new Error('provider broker mount identity changed');
    }
    if (record.binding.browserBrokerSocketPath && record.browserBroker) {
      assertIdentity(
        record.binding.browserBrokerSocketPath,
        record.browserBroker,
        'socket',
      );
    } else if (record.binding.browserBrokerSocketPath !== null ||
        record.browserBroker !== null) {
      throw new Error('provider Browser broker mount identity changed');
    }
    assertIdentity(record.binding.stateDirectory, record.state, 'directory');
    if (record.broker) assertPrivate(record.broker, this.currentUid, 'Provider broker socket');
    if (record.browserBroker) {
      assertPrivate(record.browserBroker, this.currentUid, 'Provider Browser broker socket');
    }
    assertPrivate(record.state, this.currentUid, 'Provider session state');
  }

  async release(binding: ProviderSessionHostMountBinding): Promise<void> {
    const record = this.record(binding);
    assertIdentity(this.stateRoot, this.stateRootIdentity, 'directory');
    this.removeStateExact(record.binding.stateDirectory, record.state);
    this.records.delete(binding.bindingId);
  }

  private record(binding: ProviderSessionHostMountBinding): MountRecord {
    const record = this.records.get(binding.bindingId);
    const expectedKeys = Object.keys(record?.binding ?? {}).sort();
    const actualKeys = Object.keys(binding).sort();
    if (!record || expectedKeys.length !== actualKeys.length ||
        expectedKeys.some((key, index) => key !== actualKeys[index]) ||
        expectedKeys.some((key) =>
          record.binding[key as keyof ProviderSessionHostMountBinding] !==
            binding[key as keyof ProviderSessionHostMountBinding])) {
      throw new Error('Provider session mount binding is unavailable');
    }
    return record;
  }

  private assertRoots(): void {
    assertIdentity(this.workspaceRoot, this.workspaceRootIdentity, 'directory');
    assertIdentity(this.privateRoot, this.privateRootIdentity, 'directory');
    assertIdentity(this.stateRoot, this.stateRootIdentity, 'directory');
    assertIdentity(this.brokerRoot, this.brokerRootIdentity, 'directory');
  }

  private removeStateExact(path: string, expected: PathIdentity): void {
    assertIdentity(path, expected, 'directory');
    rmSync(path, { recursive: true, force: false, maxRetries: 0 });
    if (lstatSync(path, { throwIfNoEntry: false })) {
      throw new Error('Provider session state removal was not durable');
    }
  }
}
