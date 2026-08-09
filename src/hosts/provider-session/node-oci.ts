import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

import {
  PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES,
  PROVIDER_SESSION_CONTAINER_TIMEOUT_MS,
  PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS,
  isPinnedProviderSessionImage,
  type ProviderSessionOciCommand,
  type ProviderSessionOciAttachment,
  type ProviderSessionOciInspection,
  type ProviderSessionOciPort,
  type ProviderSessionOciReadiness,
  type ProviderSessionOciEngine,
} from './types';
import {
  NodeProviderSessionProcess,
  type ProviderSessionProcessPort,
  type ProviderSessionProcessResult,
} from './node-oci-process';
import {
  NodeProviderSessionAttachmentProcess,
  type ProviderSessionAttachmentProcessPort,
} from './node-oci-attachment';

export interface NodeProviderSessionOciOptions {
  readonly attachmentProcess?: ProviderSessionAttachmentProcessPort;
  readonly currentUid?: () => number;
  readonly desktopSocketPath?: string;
  readonly desktopVm?: 'colima' | 'docker-desktop';
  readonly engine: ProviderSessionOciEngine;
  readonly executable: string;
  readonly platform?: NodeJS.Platform;
  readonly process?: ProviderSessionProcessPort;
  readonly rootlessHome?: string;
  readonly rootlessRuntimeDirectory?: string;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly uid: number;
}

const BASE_ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' });
const PROBE_TIMEOUT_MS = 5_000;
const ATTACH_STARTUP_TIMEOUT_MS = 5_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MANAGED_BY = 'agent-deck-provider-supervisor';
const RUNTIME_ADAPTER = Object.freeze({
  'claude-code-v1': 'claude-code',
  'codex-cli-v1': 'codex-cli',
  'grok-build-v1': 'grok-build',
} as const);

function normalizedAbsolute(value: string | undefined, field: string): string {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value === '/' ||
      value.includes('\0') || Buffer.byteLength(value) > 4_096) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function identity(stat: Stats): PathIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    uid: stat.uid,
  });
}

function same(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs && left.size === right.size && left.uid === right.uid;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} is invalid`);
  }
}

function labels(value: unknown): Readonly<Record<string, string>> {
  const raw = object(value ?? {}, 'provider container labels');
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== 'string' || !key || /[\0\r\n]/.test(key) || /[\0\r\n]/.test(item)) {
      throw new Error('provider container labels are invalid');
    }
    parsed[key] = item;
  }
  return Object.freeze(parsed);
}

function successful(result: ProviderSessionProcessResult, field: string): string {
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.stderr !== '') {
    throw new Error(`${field} failed`);
  }
  return result.stdout;
}

function commandMatchesAction(command: ProviderSessionOciCommand): boolean {
  const expected: Readonly<Record<ProviderSessionOciCommand['action'], readonly string[]>> = {
    attach: ['container', 'attach'],
    create: ['container', 'create'],
    inspect: ['container', 'inspect'],
    remove: ['container', 'rm'],
    start: ['container', 'start'],
    stop: ['container', 'stop'],
  };
  if (!expected[command.action].every((value, index) => command.args[index] === value)) {
    return false;
  }
  if (command.action !== 'attach') return true;
  const name = command.args.at(-1);
  return Boolean(name && NAME.test(name) && JSON.stringify(command.args.slice(0, -1)) ===
    JSON.stringify([
      'container', 'attach', '--detach-keys=ctrl-]', '--sig-proxy=false', '--',
    ]));
}

/** Production Docker/Podman command adapter. It is host-only and never exposes engine control. */
export class NodeProviderSessionOci implements ProviderSessionOciPort {
  private readonly attachmentProcess: ProviderSessionAttachmentProcessPort;
  private readonly currentUid: number;
  private readonly desktopSocketPath: string | null;
  private readonly desktopVm: 'colima' | 'docker-desktop' | null;
  private readonly engine: ProviderSessionOciEngine;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly process: ProviderSessionProcessPort;
  private executableIdentity: PathIdentity | null = null;
  private socketIdentity: PathIdentity | null = null;

  constructor(options: NodeProviderSessionOciOptions) {
    this.engine = options.engine;
    this.executable = normalizedAbsolute(options.executable, 'provider OCI executable');
    this.platform = options.platform ?? process.platform;
    this.process = options.process ?? new NodeProviderSessionProcess();
    this.attachmentProcess = options.attachmentProcess ??
      new NodeProviderSessionAttachmentProcess();
    this.currentUid = (options.currentUid ?? (() => {
      if (typeof process.getuid !== 'function') return -1;
      return process.getuid();
    }))();
    if (!Number.isSafeInteger(this.currentUid) || this.currentUid < 0) {
      throw new Error('provider OCI owner identity is invalid');
    }
    if (this.engine === 'rootless-podman') {
      const home = normalizedAbsolute(options.rootlessHome, 'rootless Podman home');
      const runtime = normalizedAbsolute(
        options.rootlessRuntimeDirectory,
        'rootless Podman runtime directory',
      );
      if (this.currentUid <= 0 || runtime !== `/run/user/${this.currentUid}` ||
          options.desktopSocketPath || options.desktopVm) {
        throw new Error('rootless Podman host configuration is invalid');
      }
      this.desktopSocketPath = null;
      this.desktopVm = null;
      this.environment = Object.freeze({
        ...BASE_ENVIRONMENT,
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
      });
    } else {
      if (options.rootlessHome || options.rootlessRuntimeDirectory ||
          !options.desktopSocketPath || !options.desktopVm) {
        throw new Error('desktop OCI host configuration is invalid');
      }
      this.desktopSocketPath = normalizedAbsolute(
        options.desktopSocketPath,
        'desktop OCI socket',
      );
      this.desktopVm = options.desktopVm;
      this.environment = Object.freeze({
        ...BASE_ENVIRONMENT,
        DOCKER_HOST: `unix://${this.desktopSocketPath}`,
      });
    }
  }

  async probe(): Promise<ProviderSessionOciReadiness> {
    try {
      this.assertPlatform();
      this.assertExecutable();
      if (this.engine === 'rootless-podman') {
        const output = successful(await this.raw(['info', '--format=json'], PROBE_TIMEOUT_MS),
          'rootless Podman probe');
        const host = object(object(parseJson(output, 'Podman info'), 'Podman info').host,
          'Podman host');
        if (object(host.security, 'Podman security').rootless !== true) {
          throw new Error('Podman is not rootless');
        }
        return Object.freeze({ available: true, boundary: 'rootless-user' });
      }
      this.assertDesktopSocket();
      const output = successful(await this.raw(['info', '--format={{json .}}'], PROBE_TIMEOUT_MS),
        'desktop OCI probe');
      const info = object(parseJson(output, 'Docker info'), 'Docker info');
      const desktop = info.OSType === 'linux' && (
        this.desktopVm === 'docker-desktop'
          ? typeof info.OperatingSystem === 'string' && /docker desktop/i.test(info.OperatingSystem)
          : info.Name === 'colima'
      );
      if (!desktop) throw new Error('desktop OCI engine is not one verified VM');
      return Object.freeze({ available: true, boundary: 'desktop-vm' });
    } catch {
      return Object.freeze({ available: false, boundary: null });
    }
  }

  async run(command: ProviderSessionOciCommand): Promise<void> {
    this.validateCommand(command);
    successful(await this.raw(command.args, command.timeoutMs, command.maxOutputBytes),
      `provider OCI ${command.action}`);
  }

  async inspect(command: ProviderSessionOciCommand): Promise<ProviderSessionOciInspection | null> {
    this.validateCommand(command);
    if (command.action !== 'inspect') throw new Error('provider OCI inspection command is invalid');
    const name = command.args.at(-1);
    if (!name || !NAME.test(name)) throw new Error('provider OCI container name is invalid');
    if (!(await this.exists(name, command))) return null;
    const output = successful(
      await this.raw(command.args, command.timeoutMs, command.maxOutputBytes),
      'provider OCI inspection',
    );
    return this.parseInspection(output);
  }

  async attach(command: ProviderSessionOciCommand): Promise<ProviderSessionOciAttachment> {
    this.validateCommand(command);
    if (command.action !== 'attach') throw new Error('provider OCI attachment command is invalid');
    return this.attachmentProcess.open({
      args: command.args,
      environment: this.environment,
      executable: this.executable,
      startupTimeoutMs: ATTACH_STARTUP_TIMEOUT_MS,
    });
  }

  /** Removes only exact, instance-labelled leftovers before the private listener becomes ready. */
  async reconcileManaged(instanceId: string): Promise<void> {
    if (!LABEL_VALUE.test(instanceId)) throw new Error('provider instance identity is invalid');
    this.assertPlatform();
    this.assertExecutable();
    if (this.engine === 'docker-desktop') this.assertDesktopSocket();
    const names = await this.listManaged(instanceId);
    if (names.length > PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS) {
      throw new Error('provider stale-container cardinality exceeded its bound');
    }
    await Promise.all(names.map((name) => this.removeManaged(name, instanceId)));
  }

  private assertPlatform(): void {
    if ((this.engine === 'rootless-podman' && this.platform !== 'linux') ||
        (this.engine === 'docker-desktop' && this.platform !== 'darwin')) {
      throw new Error('provider OCI platform is unavailable');
    }
  }

  private assertExecutable(): void {
    const stat = lstatSync(this.executable);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(this.executable) !== this.executable ||
        (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 ||
        ![0, this.currentUid].includes(stat.uid)) {
      throw new Error('provider OCI executable trust check failed');
    }
    const actual = identity(stat);
    if (this.executableIdentity && !same(this.executableIdentity, actual)) {
      throw new Error('provider OCI executable identity changed');
    }
    this.executableIdentity ??= actual;
  }

  private assertDesktopSocket(): void {
    if (!this.desktopSocketPath) throw new Error('desktop OCI socket is unavailable');
    const stat = lstatSync(this.desktopSocketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() ||
        realpathSync(this.desktopSocketPath) !== this.desktopSocketPath ||
        stat.uid !== this.currentUid || (stat.mode & 0o077) !== 0) {
      throw new Error('desktop OCI socket trust check failed');
    }
    const actual = identity(stat);
    if (this.socketIdentity && !same(this.socketIdentity, actual)) {
      throw new Error('desktop OCI socket identity changed');
    }
    this.socketIdentity ??= actual;
  }

  private validateCommand(command: ProviderSessionOciCommand): void {
    this.assertPlatform();
    this.assertExecutable();
    if (this.engine === 'docker-desktop') this.assertDesktopSocket();
    if (command.executable !== this.executable ||
        command.timeoutMs !== PROVIDER_SESSION_CONTAINER_TIMEOUT_MS ||
        command.maxOutputBytes !== PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES ||
        JSON.stringify(command.environment) !== JSON.stringify(BASE_ENVIRONMENT) ||
        !commandMatchesAction(command)) {
      throw new Error('provider OCI command escaped its fixed plan');
    }
  }

  private raw(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes = PROVIDER_SESSION_CONTAINER_MAX_OUTPUT_BYTES,
  ): Promise<ProviderSessionProcessResult> {
    return this.process.run({
      args,
      environment: this.environment,
      executable: this.executable,
      maxOutputBytes,
      timeoutMs,
    });
  }

  private async listManaged(instanceId: string): Promise<string[]> {
    const output = successful(await this.raw([
      'container', 'ls', '--all',
      '--filter', `label=io.agent-deck.managed-by=${MANAGED_BY}`,
      '--filter', `label=io.agent-deck.instance=${instanceId}`,
      '--format={{.Names}}', '--no-trunc',
    ], PROVIDER_SESSION_CONTAINER_TIMEOUT_MS), 'provider stale-container listing');
    if (output === '') return [];
    const names = output.split('\n').filter(Boolean);
    if (!output.endsWith('\n') || new Set(names).size !== names.length ||
        names.some((name) => !NAME.test(name) || !name.startsWith('agent-deck-provider-'))) {
      throw new Error('provider stale-container listing is invalid');
    }
    return names;
  }

  private async removeManaged(
    name: string,
    instanceId: string,
  ): Promise<void> {
    const output = successful(await this.raw([
      'container', 'inspect', '--format=json', '--', name,
    ], PROVIDER_SESSION_CONTAINER_TIMEOUT_MS), 'provider stale-container inspection');
    const inspected = this.parseInspection(output);
    const runtime = inspected.labels['io.agent-deck.runtime'];
    const adapter = inspected.labels['io.agent-deck.adapter'];
    const identity = inspected.labels['io.agent-deck.identity'];
    if (!(runtime && runtime in RUNTIME_ADAPTER) || adapter !==
        RUNTIME_ADAPTER[runtime as keyof typeof RUNTIME_ADAPTER] ||
        inspected.labels['io.agent-deck.instance'] !== instanceId ||
        inspected.labels['io.agent-deck.managed-by'] !== MANAGED_BY ||
        typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity) ||
        inspected.name !== `agent-deck-provider-${identity.slice(0, 24)}` ||
        !isPinnedProviderSessionImage(inspected.image)) {
      throw new Error('provider stale-container identity changed');
    }
    if (inspected.running) {
      successful(await this.raw([
        'container', 'stop', '--time', '10', '--', name,
      ], PROVIDER_SESSION_CONTAINER_TIMEOUT_MS), 'provider stale-container stop');
    }
    successful(await this.raw([
      'container', 'rm', '--force', '--volumes', '--', name,
    ], PROVIDER_SESSION_CONTAINER_TIMEOUT_MS), 'provider stale-container removal');
  }

  private async exists(name: string, command: ProviderSessionOciCommand): Promise<boolean> {
    if (this.engine === 'rootless-podman') {
      const result = await this.raw(
        ['container', 'exists', '--', name],
        command.timeoutMs,
        command.maxOutputBytes,
      );
      if (result.timedOut || result.outputTruncated || result.stdout !== '' || result.stderr !== '' ||
          (result.exitCode !== 0 && result.exitCode !== 1)) {
        throw new Error('provider OCI existence check failed');
      }
      return result.exitCode === 0;
    }
    const output = successful(await this.raw([
      'container', 'ls', '--all', '--filter', `name=^/${name}$`,
      '--format={{.Names}}', '--no-trunc',
    ], command.timeoutMs, command.maxOutputBytes), 'provider OCI existence check');
    if (output === '') return false;
    if (output !== `${name}\n`) throw new Error('provider OCI existence output is invalid');
    return true;
  }

  private parseInspection(output: string): ProviderSessionOciInspection {
    const parsed = parseJson(output, 'provider OCI inspection');
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error('provider OCI inspection cardinality is invalid');
    }
    const raw = object(parsed[0], 'provider OCI inspection');
    const config = object(raw.Config, 'provider OCI config');
    const state = object(raw.State, 'provider OCI state');
    const rawName = typeof raw.Name === 'string' && raw.Name.startsWith('/')
      ? raw.Name.slice(1)
      : raw.Name;
    const imageCandidates = [config.Image, raw.ImageName]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (!NAME.test(String(rawName)) || typeof raw.Id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.Id) || typeof state.Running !== 'boolean' ||
        imageCandidates.length === 0 || new Set(imageCandidates).size !== 1) {
      throw new Error('provider OCI inspection identity is invalid');
    }
    return Object.freeze({
      image: imageCandidates[0]!,
      labels: labels(config.Labels),
      name: rawName as string,
      running: state.Running,
      runtimeHandle: raw.Id,
    });
  }
}
