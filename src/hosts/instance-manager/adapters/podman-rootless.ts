import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type {
  CommandPort,
  CommandResult,
  PodmanContainerInspection,
  PodmanImageInspection,
  PodmanPort,
  PodmanVolumeInspection,
} from '../types';
import { LinuxHostAdapterError } from './errors';

export interface RootlessPodmanPortOptions {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinuxHostAdapterError('output_invalid', 'Podman output was not an object');
  }
  return value as Record<string, unknown>;
}

function parseOne(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new LinuxHostAdapterError('output_invalid', 'Podman output was not JSON');
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new LinuxHostAdapterError('output_invalid', 'Podman inspection cardinality was invalid');
  }
  return object(value[0]);
}

function labels(value: unknown): Readonly<Record<string, string>> {
  const record = object(value ?? {});
  const output: Record<string, string> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested !== 'string') {
      throw new LinuxHostAdapterError('output_invalid', 'Podman labels were invalid');
    }
    output[key] = nested;
  }
  return Object.freeze(output);
}

function exactLabels(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function safeName(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new LinuxHostAdapterError('command_failed', `${field} was rejected`);
  }
}

function safeMountpoint(value: unknown): string {
  if (
    typeof value !== 'string' || !posix.isAbsolute(value) ||
    posix.normalize(value) !== value || value === '/' ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw new LinuxHostAdapterError('output_invalid', 'Podman volume mountpoint was invalid');
  }
  return value;
}

function volumeIdentity(createdAt: string, mountpoint: string): string {
  return createHash('sha256').update(createdAt).update('\0').update(mountpoint).digest('hex');
}

export class RootlessPodmanCommandPort implements PodmanPort {
  private readonly executable: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly maxOutputBytes: number;
  private rootlessCheck: Promise<void> | null = null;

  constructor(
    private readonly commands: CommandPort,
    options: RootlessPodmanPortOptions = {},
  ) {
    this.executable = options.executable ?? '/usr/bin/podman';
    this.environment = options.environment ?? {};
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  private run(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return this.commands.run({
      executable: this.executable,
      args,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      environment: this.environment,
    });
  }

  private async successful(args: readonly string[], timeoutMs: number): Promise<string> {
    await this.ensureRootless(timeoutMs);
    const result = await this.run(args, timeoutMs);
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.outputTruncated ||
      result.stderr !== ''
    ) {
      throw new LinuxHostAdapterError('command_failed', 'Rootless Podman operation failed');
    }
    return result.stdout;
  }

  private ensureRootless(timeoutMs: number): Promise<void> {
    this.rootlessCheck ??= (async () => {
      const result = await this.run(['info', '--format=json'], timeoutMs);
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.outputTruncated ||
        result.stderr !== ''
      ) {
        throw new LinuxHostAdapterError('command_failed', 'Podman rootless preflight failed');
      }
      let info: Record<string, unknown>;
      try {
        info = object(JSON.parse(result.stdout));
      } catch (error) {
        if (error instanceof LinuxHostAdapterError) throw error;
        throw new LinuxHostAdapterError('output_invalid', 'Podman info was invalid');
      }
      const host = object(info.host);
      const security = object(host.security);
      if (security.rootless !== true) {
        throw new LinuxHostAdapterError('trust_failed', 'Podman is not rootless');
      }
    })();
    return this.rootlessCheck;
  }

  private async exists(kind: 'container' | 'image' | 'volume', name: string, timeoutMs: number): Promise<boolean> {
    await this.ensureRootless(timeoutMs);
    const result = await this.run([kind, 'exists', '--', name], timeoutMs);
    if (result.timedOut || result.outputTruncated || result.stdout !== '' || result.stderr !== '') {
      throw new LinuxHostAdapterError('command_failed', 'Podman existence check failed');
    }
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new LinuxHostAdapterError('command_failed', 'Podman existence check failed');
  }

  async inspectImage(reference: string, timeoutMs: number): Promise<PodmanImageInspection | null> {
    if (!/^[^\s\0]+@sha256:[a-f0-9]{64}$/.test(reference)) {
      throw new LinuxHostAdapterError('command_failed', 'Podman image reference was rejected');
    }
    if (!(await this.exists('image', reference, timeoutMs))) return null;
    const inspected = parseOne(await this.successful([
      'image',
      'inspect',
      '--format=json',
      '--',
      reference,
    ], timeoutMs));
    const digest = inspected.Digest;
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new LinuxHostAdapterError('output_invalid', 'Podman image digest was invalid');
    }
    return { reference, digest };
  }

  private async inspectVolumeDetails(name: string, timeoutMs: number): Promise<{
    readonly volume: PodmanVolumeInspection;
    readonly mountpoint: string;
  } | null> {
    safeName(name, 'volume name');
    if (!(await this.exists('volume', name, timeoutMs))) return null;
    const inspected = parseOne(await this.successful([
      'volume',
      'inspect',
      '--format=json',
      '--',
      name,
    ], timeoutMs));
    if (
      inspected.Name !== name ||
      typeof inspected.CreatedAt !== 'string'
    ) {
      throw new LinuxHostAdapterError('output_invalid', 'Podman volume identity was invalid');
    }
    const mountpoint = safeMountpoint(inspected.Mountpoint);
    return {
      volume: {
        name,
        identity: volumeIdentity(inspected.CreatedAt, mountpoint),
        labels: labels(inspected.Labels),
      },
      mountpoint,
    };
  }

  async inspectVolume(name: string, timeoutMs: number): Promise<PodmanVolumeInspection | null> {
    return (await this.inspectVolumeDetails(name, timeoutMs))?.volume ?? null;
  }

  async createVolume(
    name: string,
    expectedLabels: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<PodmanVolumeInspection> {
    safeName(name, 'volume name');
    const args = ['volume', 'create'];
    for (const [key, value] of Object.entries(expectedLabels).sort(([left], [right]) => left.localeCompare(right))) {
      if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(key) || /[\0\r\n]/.test(value)) {
        throw new LinuxHostAdapterError('command_failed', 'Podman volume labels were rejected');
      }
      args.push('--label', `${key}=${value}`);
    }
    args.push('--', name);
    const output = await this.successful(args, timeoutMs);
    if (output !== `${name}\n`) {
      throw new LinuxHostAdapterError('output_invalid', 'Podman volume creation output was invalid');
    }
    const inspected = await this.inspectVolume(name, timeoutMs);
    if (!inspected || !exactLabels(inspected.labels, expectedLabels)) {
      throw new LinuxHostAdapterError('identity_changed', 'Podman volume creation fence failed');
    }
    return inspected;
  }

  async removeVolumeExact(volume: PodmanVolumeInspection, timeoutMs: number): Promise<void> {
    const current = await this.inspectVolume(volume.name, timeoutMs);
    if (
      !current ||
      current.identity !== volume.identity ||
      !exactLabels(current.labels, volume.labels)
    ) {
      throw new LinuxHostAdapterError('identity_changed', 'Podman volume removal fence failed');
    }
    const output = await this.successful(['volume', 'rm', '--', volume.name], timeoutMs);
    if (output !== `${volume.name}\n`) {
      throw new LinuxHostAdapterError('output_invalid', 'Podman volume removal output was invalid');
    }
  }

  async resolveVolumeDataPathExact(
    volume: PodmanVolumeInspection,
    timeoutMs: number,
  ): Promise<string> {
    const current = await this.inspectVolumeDetails(volume.name, timeoutMs);
    if (
      !current || current.volume.identity !== volume.identity ||
      !exactLabels(current.volume.labels, volume.labels)
    ) {
      throw new LinuxHostAdapterError('identity_changed', 'Podman volume data-path fence failed');
    }
    return current.mountpoint;
  }

  async inspectContainer(name: string, timeoutMs: number): Promise<PodmanContainerInspection | null> {
    safeName(name, 'container name');
    if (!(await this.exists('container', name, timeoutMs))) return null;
    const inspected = parseOne(await this.successful([
      'container',
      'inspect',
      '--format=json',
      '--',
      name,
    ], timeoutMs));
    const state = object(inspected.State);
    const healthObject = state.Health === undefined ? null : object(state.Health);
    const healthValue = healthObject?.Status ?? 'none';
    const health = healthValue === '' ? 'none' : healthValue;
    if (
      inspected.Name !== name ||
      typeof inspected.ImageName !== 'string' ||
      typeof state.Running !== 'boolean' ||
      !['healthy', 'starting', 'unhealthy', 'none'].includes(String(health))
    ) {
      throw new LinuxHostAdapterError('output_invalid', 'Podman container identity was invalid');
    }
    return {
      name,
      image: inspected.ImageName,
      health: health as PodmanContainerInspection['health'],
      running: state.Running,
    };
  }
}
