import { posix } from 'node:path';

import { LinuxInstanceManager, type InstanceManagerOptions } from './manager';
import type {
  CommandPort,
  CommandRequest,
  CommandResult,
  HostInstanceLock,
  HostInstanceLeasePort,
  FullResourceSpec,
  PodmanContainerInspection,
  PodmanImageInspection,
  PodmanPort,
  PodmanVolumeInspection,
  SystemdPort,
  SystemdUnitStatus,
} from './types';
import { FakeFileSystem } from './fake-filesystem';
import { sameFileSnapshot } from './validation';
import { sha256 } from './serialization';
import { renderQuadlet } from './render';

export { FakeFileSystem } from './fake-filesystem';

export class FakeCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  failNext = false;
  tamperNextOutput = false;
  pauseNext: (() => void) | null = null;
  beforeRun: (() => void) | null = null;
  beforeRuntimeRun: (() => void) | null = null;

  constructor(private readonly fileSystem: FakeFileSystem) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    this.beforeRun?.();
    this.beforeRun = null;
    for (const artifact of request.trustedArtifacts ?? []) {
      const identity = await this.fileSystem.lstat(artifact.path);
      const bytes = await this.fileSystem.readFile(artifact.path, 128_000);
      if (!identity || !sameFileSnapshot(identity, artifact.identity) || sha256(bytes) !== artifact.sha256) {
        return { exitCode: 126, stdout: '', stderr: '', timedOut: false, outputTruncated: false };
      }
    }
    if (this.pauseNext) {
      const started = this.pauseNext;
      this.pauseNext = null;
      await new Promise<void>((resolve) => {
        started();
        this.resume = resolve;
      });
    }
    if (this.failNext) {
      this.failNext = false;
      return { exitCode: 9, stdout: '', stderr: 'secret output', timedOut: false, outputTruncated: false };
    }
    const relay = request.args.includes('--quadlet');
    const runtime = relay && !request.args.includes('--static-only');
    if (runtime) {
      this.beforeRuntimeRun?.();
      this.beforeRuntimeRun = null;
    }
    let stdout = relay
      ? runtime
        ? 'relay preflight: runtime identity, health scheduler, and external egress/quota acceptance gates passed\n'
        : 'relay preflight: static exact-template checks passed; runtime gates remain unverified\n'
      : '';
    if (this.tamperNextOutput) {
      this.tamperNextOutput = false;
      stdout += 'unexpected\n';
    }
    return { exitCode: 0, stdout, stderr: '', timedOut: false, outputTruncated: false };
  }

  resume: () => void = () => undefined;
}

export class FakePodman implements PodmanPort {
  readonly images = new Set<string>();
  readonly volumes = new Map<string, PodmanVolumeInspection>();
  readonly volumeDataPaths = new Map<string, string>();
  readonly containers = new Map<string, PodmanContainerInspection>();
  nextVolume = 1;
  unhealthyImages = new Set<string>();
  readonly containerInspectionSequences = new Map<
    string,
    (PodmanContainerInspection | null)[]
  >();
  resolveVolumeDataPathCalls = 0;
  afterResolveVolumeDataPath: ((
    volume: PodmanVolumeInspection,
    path: string,
    call: number,
  ) => void) | null = null;

  constructor(private readonly fileSystem?: FakeFileSystem) {}

  async inspectImage(reference: string): Promise<PodmanImageInspection | null> {
    if (!this.images.has(reference)) return null;
    return { reference, digest: reference.slice(reference.lastIndexOf('@') + 1) };
  }

  async inspectVolume(name: string): Promise<PodmanVolumeInspection | null> {
    return this.volumes.get(name) ?? null;
  }

  async createVolume(
    name: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<PodmanVolumeInspection> {
    if (this.volumes.has(name)) throw new Error('volume exists');
    const volume = { name, identity: `volume-${this.nextVolume++}`, labels: { ...labels } };
    this.volumes.set(name, volume);
    const dataPath = `/srv/rootless-volumes/${name}/_data`;
    this.volumeDataPaths.set(name, dataPath);
    this.fileSystem?.seedDirectoryChain(dataPath, 0o700, 1001);
    return volume;
  }

  async resolveVolumeDataPathExact(volume: PodmanVolumeInspection): Promise<string> {
    if (this.volumes.get(volume.name)?.identity !== volume.identity) {
      throw new Error('volume identity');
    }
    const path = this.volumeDataPaths.get(volume.name);
    if (!path) throw new Error('volume data path');
    this.resolveVolumeDataPathCalls += 1;
    this.afterResolveVolumeDataPath?.(
      volume,
      path,
      this.resolveVolumeDataPathCalls,
    );
    return path;
  }

  async removeVolumeExact(volume: PodmanVolumeInspection): Promise<void> {
    if (this.volumes.get(volume.name)?.identity !== volume.identity) throw new Error('volume identity');
    this.volumes.delete(volume.name);
    const dataPath = this.volumeDataPaths.get(volume.name);
    this.volumeDataPaths.delete(volume.name);
    if (dataPath && this.fileSystem?.exists(dataPath)) {
      await this.fileSystem.removeTreeExact(
        await this.fileSystem.captureTreeExact(dataPath, 10_000),
      );
    }
  }

  async inspectContainer(name: string): Promise<PodmanContainerInspection | null> {
    const sequence = this.containerInspectionSequences.get(name);
    if (sequence?.length) return sequence.shift() ?? null;
    return this.containers.get(name) ?? null;
  }
}

export class FakeSystemd implements SystemdPort {
  readonly active = new Map<string, SystemdUnitStatus['activeState']>();
  readonly calls: string[] = [];
  failNextStart = false;
  partialFailNextStart = false;
  failStartCount = 0;
  readonly failStartImages = new Set<string>();
  statusFragmentOverride: string | null = null;
  failNextReload = false;
  failNextStop = false;
  afterReload: (() => void) | null = null;

  constructor(
    private readonly fileSystem: FakeFileSystem,
    private readonly unitRoot: string,
    private readonly podman: FakePodman,
  ) {}

  private unitPath(unitName: string): string {
    return posix.join(this.unitRoot, unitName.replace(/\.service$/, '.container'));
  }

  async daemonReload(): Promise<void> {
    this.calls.push('reload');
    if (this.failNextReload) {
      this.failNextReload = false;
      throw new Error('reload failed');
    }
    const afterReload = this.afterReload;
    this.afterReload = null;
    afterReload?.();
  }

  async statusUserUnit(unitName: string): Promise<SystemdUnitStatus> {
    this.calls.push(`status:${unitName}`);
    const unitPath = this.unitPath(unitName);
    const exists = this.fileSystem.exists(unitPath);
    return {
      unitName,
      fragmentPath: this.statusFragmentOverride ?? (exists ? unitPath : ''),
      loadState: exists ? 'loaded' : 'not-found',
      activeState: this.active.get(unitName) ?? 'inactive',
      subState: this.active.get(unitName) === 'active' ? 'running' : 'dead',
    };
  }

  async startUserUnit(unitName: string): Promise<void> {
    this.calls.push(`start:${unitName}`);
    const unit = this.fileSystem.readText(this.unitPath(unitName));
    const image = /^Image=(.+)$/m.exec(unit)?.[1] ?? '';
    if (this.partialFailNextStart) {
      this.partialFailNextStart = false;
      this.active.set(unitName, 'active');
      throw new Error('partial start failed');
    }
    if (this.failNextStart || this.failStartCount > 0 || this.failStartImages.has(image)) {
      this.failNextStart = false;
      this.failStartCount = Math.max(0, this.failStartCount - 1);
      throw new Error('start failed');
    }
    this.active.set(unitName, 'active');
    const topology = unitName.includes('-full@') ? 'full' : 'relay';
    const instanceId = unitName.slice(unitName.indexOf('@') + 1, -'.service'.length);
    this.podman.containers.set(`agent-deck-${topology}-${instanceId}`, {
      name: `agent-deck-${topology}-${instanceId}`,
      image,
      running: true,
      health: this.podman.unhealthyImages.has(image) ? 'unhealthy' : 'healthy',
    });
  }

  async stopUserUnit(unitName: string): Promise<void> {
    this.calls.push(`stop:${unitName}`);
    if (this.failNextStop) {
      this.failNextStop = false;
      throw new Error('stop failed');
    }
    this.active.set(unitName, 'inactive');
  }
}

export class FakeHostLeases implements HostInstanceLeasePort {
  private readonly held = new Map<string, HostInstanceLock>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private nextLease = 1;
  invalidNextHandle: Partial<HostInstanceLock> | null = null;
  readonly quarantined: unknown[] = [];

  isHeld(key: string): boolean { return this.held.has(key); }

  async acquire(input: { readonly key: string; readonly ownerToken: string; readonly timeoutMs: number }): Promise<HostInstanceLock> {
    const existing = this.held.get(input.key);
    if (existing) {
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(input.key) ?? [];
        queue.push(resolve);
        this.waiters.set(input.key, queue);
      });
    }
    const lease: HostInstanceLock = {
      key: input.key,
      ownerToken: input.ownerToken,
      lockId: `lease-${this.nextLease++}`,
      acquiredAtMs: 1,
      ...this.invalidNextHandle,
    };
    this.invalidNextHandle = null;
    this.held.set(input.key, lease);
    return lease;
  }

  async release(lease: HostInstanceLock): Promise<void> {
    if (this.held.get(lease.key)?.lockId !== lease.lockId) throw new Error('lease ownership changed');
    this.held.delete(lease.key);
    this.waiters.get(lease.key)?.shift()?.();
  }

  async quarantine(lock: unknown): Promise<void> {
    this.quarantined.push(lock);
    for (const [key, held] of this.held) {
      if (held === lock) {
        this.held.delete(key);
        this.waiters.get(key)?.shift()?.();
      }
    }
  }
}

const FULL_TEMPLATE = `# full\n[Container]\nImage=@@IMAGE_DIGEST@@\nContainerName=agent-deck-full-%i\nNetwork=@@VERIFIED_EGRESS_NETWORK@@\nTmpfs=/tmp:size=@@TMPFS_SIZE@@\nMemory=@@MEMORY_LIMIT@@\nPidsLimit=@@PIDS_LIMIT@@\nPodmanArgs=--cpus=@@CPU_LIMIT@@ --storage-opt=size=@@ROOTFS_SIZE@@\nLogOpt=max-size=@@LOG_SIZE@@\n`;
const RELAY_TEMPLATE = `# relay\n[Container]\nImage=localhost/agent-deck-relay@sha256:__REPLACE_WITH_PINNED_DIGEST__\nContainerName=agent-deck-relay-%i\n`;

export const DIGEST_A = `registry.example/agent-deck@sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `registry.example/agent-deck@sha256:${'b'.repeat(64)}`;

export function createHarness(): {
  readonly manager: LinuxInstanceManager;
  readonly options: InstanceManagerOptions;
  readonly fileSystem: FakeFileSystem;
  readonly commands: FakeCommands;
  readonly podman: FakePodman;
  readonly systemd: FakeSystemd;
  readonly leases: FakeHostLeases;
  readonly setNow: (value: number) => void;
  readonly healthSleeps: number[];
} {
  let now = 10_000;
  const fileSystem = new FakeFileSystem(() => now);
  const roots = {
    serviceHome: '/srv/agent-deck-user',
    runtimeRoot: '/run/user/1001',
    unitRoot: '/srv/quadlet',
    metadataRoot: '/srv/manager-metadata',
    backupRoot: '/srv/manager-backups',
    journalRoot: '/srv/manager-journals',
    cutoverEvidenceRoot: '/etc/agent-deck-manager/evidence',
    fullTemplatePath: '/opt/agent-deck/full@.container.in',
    fullPreflightPath: '/opt/agent-deck/full-preflight.sh',
    relayTemplatePath: '/opt/agent-deck/relay@.container',
    relayPreflightPath: '/opt/agent-deck/relay-preflight.sh',
    relayEvidenceRoot: '/etc/agent-deck-relay/evidence',
  } as const;
  for (const path of [
    roots.serviceHome,
    roots.runtimeRoot,
    roots.unitRoot,
    roots.metadataRoot,
    roots.backupRoot,
    roots.journalRoot,
  ]) {
    fileSystem.seedTrustedLeaf(path, 0o700, 1001);
  }
  fileSystem.seedTrustedLeaf(roots.relayEvidenceRoot, 0o555, 0);
  fileSystem.seedTrustedLeaf(roots.cutoverEvidenceRoot, 0o555, 0);
  fileSystem.seedFile(roots.fullTemplatePath, FULL_TEMPLATE, { mode: 0o444, uid: 0 });
  fileSystem.seedFile(roots.fullPreflightPath, '#!/bin/sh\n', { mode: 0o555, uid: 0 });
  fileSystem.seedFile(roots.relayTemplatePath, RELAY_TEMPLATE, { mode: 0o444, uid: 0 });
  fileSystem.seedFile(roots.relayPreflightPath, '#!/bin/sh\n', { mode: 0o555, uid: 0 });
  const commands = new FakeCommands(fileSystem);
  const podman = new FakePodman(fileSystem);
  podman.images.add(DIGEST_A);
  podman.images.add(DIGEST_B);
  const systemd = new FakeSystemd(fileSystem, roots.unitRoot, podman);
  let nextId = 1;
  const leases = new FakeHostLeases();
  const healthSleeps: number[] = [];
  const options: InstanceManagerOptions = {
    roots,
    ports: {
      fileSystem,
      commands,
      podman,
      systemd,
      clock: {
        nowMs: () => now,
        sleep: async (ms: number) => {
          healthSleeps.push(ms);
          now += ms;
        },
      },
      ids: { nextId: () => `operation-${nextId++}` },
      leases,
    },
    serviceUid: 1001,
    trustedRootUid: 0,
    trustedArtifactUid: 0,
    limits: {
      commandTimeoutMs: 60_000,
      lifecycleTimeoutMs: 60_000,
      healthTimeoutMs: 30_000,
      maxOutputBytes: 16_384,
      maxArtifactBytes: 128_000,
      maxEvidenceAgeMs: 300_000,
    },
  };
  return {
    manager: new LinuxInstanceManager(options),
    options,
    fileSystem,
    commands,
    podman,
    systemd,
    leases,
    healthSleeps,
    setNow: (value) => {
      now = value;
    },
  };
}

export const FULL_RESOURCES = {
  cpuCores: 2,
  memoryBytes: 4_294_967_296,
  pids: 512,
  rootfsBytes: 21_474_836_480,
  tmpfsBytes: 67_108_864,
  logBytes: 268_435_456,
} as const;

export function seedEvidence(
  harness: ReturnType<typeof createHarness>,
  topology: 'full' | 'relay',
  instanceId: string,
  target: {
    generation?: number;
    version?: string;
    image?: string;
    fullResources?: FullResourceSpec;
  } = {},
): void {
  const modifiedAtMs = harness.options.ports.clock.nowMs();
  const generation = target.generation ?? 1;
  const version = target.version ?? 'v1';
  const image = target.image ?? DIGEST_A;
  const fullResources = target.fullResources ?? FULL_RESOURCES;
  const templatePath = topology === 'full' ? harness.options.roots.fullTemplatePath : harness.options.roots.relayTemplatePath;
  const unitSha256 = sha256(new TextEncoder().encode(renderQuadlet({
    topology,
    instanceId,
    image,
    template: new TextEncoder().encode(harness.fileSystem.readText(templatePath)),
    fullResources: topology === 'full' ? fullResources : undefined,
  })));
  if (topology === 'full') {
    const root = `/srv/agent-deck-user/.config/agent-deck/instances/${instanceId}`;
    harness.fileSystem.seedFile(
      `${root}/egress-policy.verified`,
      `schemaVersion=1\ninstanceId=${instanceId}\ntopology=full\npublicOnlyEgressVerified=true\nprivateAndLinkLocalDenied=true\ncloudMetadataDenied=true\n`,
      { mode: 0o444, uid: 1001, modifiedAtMs },
    );
    harness.fileSystem.seedFile(
      `${root}/volume-quota.verified`,
      `schemaVersion=1\ninstanceId=${instanceId}\ntopology=full\nstateVolume=agent-deck-${instanceId}-state\nworkspaceVolume=agent-deck-${instanceId}-workspace\nsocketVolume=agent-deck-${instanceId}-socket\nbrowserVolume=agent-deck-${instanceId}-browser\nsecretsVolume=agent-deck-${instanceId}-secrets\nvolumeQuotaEnforced=true\n`,
      { mode: 0o444, uid: 1001, modifiedAtMs },
    );
  } else {
    const evidenceRoot = `/etc/agent-deck-relay/evidence/${instanceId}`;
    harness.fileSystem.seedDirectoryChain(evidenceRoot, 0o555, 0);
    const statePath = `/srv/agent-deck-user/.local/share/agent-deck-relay/${instanceId}`;
    harness.fileSystem.seedFile(
      `${evidenceRoot}/egress.env`,
      `schemaVersion=1\ninstanceId=${instanceId}\npublicOnlyEgressVerified=true\nprivateAndLinkLocalDenied=true\ncloudMetadataDenied=true\n`,
      { mode: 0o444, uid: 0, modifiedAtMs },
    );
    harness.fileSystem.seedFile(
      `${evidenceRoot}/quota.env`,
      `schemaVersion=1\ninstanceId=${instanceId}\nstatePath=${statePath}\nstateQuotaEnforced=true\nstateQuotaBytes=1073741824\n`,
      { mode: 0o444, uid: 0, modifiedAtMs },
    );
  }
  const cutoverRoot = `/etc/agent-deck-manager/evidence/${topology}/${instanceId}/${generation}-${version}`;
  harness.fileSystem.seedDirectoryChain(cutoverRoot, 0o555, 0);
  const common = `schemaVersion=2\ntopology=${topology}\ninstanceId=${instanceId}\ngeneration=${generation}\nversion=${version}\nimage=${image}\nunitSha256=${unitSha256}\n`;
  const network = topology === 'full'
    ? `networkName=agent-deck-${instanceId}-egress\nnetworkPolicy=public-dns-http-https-only\n`
    : 'networkName=slirp4netns:allow_host_loopback=false\nnetworkPolicy=public-only-private-linklocal-metadata-denied\n';
  harness.fileSystem.seedFile(
    `${cutoverRoot}/egress.env`,
    `${common}${network}egressVerified=true\n`,
    { mode: 0o444, uid: 0, modifiedAtMs },
  );
  const quota = topology === 'full'
    ? `cpuCores=${fullResources.cpuCores}\nmemoryBytes=${fullResources.memoryBytes}\npids=${fullResources.pids}\nrootfsBytes=${fullResources.rootfsBytes}\ntmpfsBytes=${fullResources.tmpfsBytes}\nlogBytes=${fullResources.logBytes}\nvolumes=${['state', 'workspace', 'socket', 'browser', 'secrets'].map((suffix) => `agent-deck-${instanceId}-${suffix}`).join(',')}\n`
    : `statePath=/srv/agent-deck-user/.local/share/agent-deck-relay/${instanceId}\nstateQuotaBytes=1073741824\n`;
  harness.fileSystem.seedFile(
    `${cutoverRoot}/quota.env`,
    `${common}${quota}quotaVerified=true\n`,
    { mode: 0o444, uid: 0, modifiedAtMs },
  );
}
