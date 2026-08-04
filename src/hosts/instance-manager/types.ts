export type ManagedTopology = 'full' | 'relay';

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly identity: FileIdentity;
}

export interface ExactTreeEntry {
  readonly relativePath: string;
  readonly identity: FileIdentity;
}

export interface ExactTreeSnapshot {
  readonly rootPath: string;
  readonly rootIdentity: FileIdentity;
  readonly entries: readonly ExactTreeEntry[];
}

export interface TrustedFileArtifact {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly sha256: string;
}

export interface FileSystemPort {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<FileIdentity | null>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  listDirectory(path: string, maxEntries: number): Promise<readonly DirectoryEntry[]>;
  createDirectory(path: string, mode: number): Promise<FileIdentity>;
  createFileExclusive(path: string, data: Uint8Array, mode: number): Promise<FileIdentity>;
  replaceFileAtomic(
    stagedPath: string,
    targetPath: string,
    expectedTarget: FileIdentity | null,
  ): Promise<FileIdentity>;
  removeFileExact(path: string, expected: FileIdentity): Promise<void>;
  removeDirectoryExact(path: string, expected: FileIdentity): Promise<void>;
  captureTreeExact(rootPath: string, maxEntries: number): Promise<ExactTreeSnapshot>;
  removeTreeExact(snapshot: ExactTreeSnapshot): Promise<void>;
}

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly trustedArtifacts?: readonly TrustedFileArtifact[];
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface CommandPort {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface SystemdUnitStatus {
  readonly unitName: string;
  readonly fragmentPath: string;
  readonly loadState: 'loaded' | 'not-found' | 'error';
  readonly activeState: 'active' | 'activating' | 'deactivating' | 'failed' | 'inactive';
  readonly subState: string;
}

export interface SystemdPort {
  daemonReload(timeoutMs: number): Promise<void>;
  statusUserUnit(unitName: string, timeoutMs: number): Promise<SystemdUnitStatus>;
  startUserUnit(unitName: string, timeoutMs: number): Promise<void>;
  stopUserUnit(unitName: string, timeoutMs: number): Promise<void>;
}

export interface PodmanImageInspection {
  readonly reference: string;
  readonly digest: string;
}

export interface PodmanVolumeInspection {
  readonly name: string;
  readonly identity: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PodmanContainerInspection {
  readonly name: string;
  readonly image: string;
  readonly health: 'healthy' | 'starting' | 'unhealthy' | 'none';
  readonly running: boolean;
}

export interface PodmanPort {
  inspectImage(reference: string, timeoutMs: number): Promise<PodmanImageInspection | null>;
  inspectVolume(name: string, timeoutMs: number): Promise<PodmanVolumeInspection | null>;
  createVolume(
    name: string,
    labels: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<PodmanVolumeInspection>;
  removeVolumeExact(volume: PodmanVolumeInspection, timeoutMs: number): Promise<void>;
  inspectContainer(name: string, timeoutMs: number): Promise<PodmanContainerInspection | null>;
}

export interface ClockPort {
  nowMs(): number;
}

export interface IdPort {
  nextId(): string;
}

export interface HostInstanceLock {
  readonly key: string;
  readonly ownerToken: string;
  readonly lockId: string;
  readonly acquiredAtMs: number;
}

export interface HostInstanceLeasePort {
  acquire(input: {
    readonly key: string;
    readonly ownerToken: string;
    readonly timeoutMs: number;
  }): Promise<HostInstanceLock>;
  /** Exact ownership is held until release; a production adapter releases it on process death. */
  release(lock: HostInstanceLock, timeoutMs: number): Promise<void>;
  /** Best-effort containment for a malformed handle returned by an untrusted adapter. */
  quarantine(lock: unknown, timeoutMs: number): Promise<void>;
}

export interface InstanceManagerPorts {
  readonly fileSystem: FileSystemPort;
  readonly commands: CommandPort;
  readonly systemd: SystemdPort;
  readonly podman: PodmanPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly leases: HostInstanceLeasePort;
}

export interface InstanceManagerRoots {
  readonly serviceHome: string;
  readonly runtimeRoot: string;
  readonly unitRoot: string;
  readonly metadataRoot: string;
  readonly backupRoot: string;
  readonly journalRoot: string;
  readonly cutoverEvidenceRoot: string;
  readonly fullTemplatePath: string;
  readonly fullPreflightPath: string;
  readonly relayTemplatePath: string;
  readonly relayPreflightPath: string;
  readonly relayEvidenceRoot: string;
}

export interface ManagerLimits {
  readonly commandTimeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly healthTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxEvidenceAgeMs: number;
}

export interface FullResourceSpec {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly rootfsBytes: number;
  readonly tmpfsBytes: number;
  readonly logBytes: number;
}

export interface CreateInstanceRequest {
  readonly topology: ManagedTopology;
  readonly instanceId: string;
  readonly version: string;
  readonly image: string;
  readonly runtimeConfig: unknown;
  readonly fullResources?: FullResourceSpec;
}

export interface InstanceSelector {
  readonly topology: ManagedTopology;
  readonly instanceId: string;
}

export interface VersionFence extends InstanceSelector {
  readonly expectedGeneration: number;
  readonly expectedVersion: string;
}

export interface UpgradeInstanceRequest extends VersionFence {
  readonly nextVersion: string;
  readonly nextImage: string;
  readonly runtimeConfig: unknown;
  readonly fullResources?: FullResourceSpec;
}

export interface RemoveInstanceRequest extends VersionFence {
  readonly confirmationToken: string;
  readonly deleteData: boolean;
  readonly keepBackups: boolean;
}

export interface RemovePlanRequest extends InstanceSelector {
  readonly deleteData: boolean;
  readonly keepBackups: boolean;
}

export interface ManagedVersion {
  readonly version: string;
  readonly image: string;
  readonly unitSha256: string;
  readonly configSha256: string;
  readonly unitBackupPath: string;
  readonly configBackupPath: string;
  readonly fullResources: FullResourceSpec | null;
  readonly createdAtMs: number;
}

export interface InstanceRecord {
  readonly schemaVersion: 1;
  readonly topology: ManagedTopology;
  readonly instanceId: string;
  readonly generation: number;
  readonly currentVersion: string;
  readonly previousVersion: string | null;
  readonly versions: readonly ManagedVersion[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InstanceSummary extends InstanceSelector {
  readonly generation: number;
  readonly currentVersion: string;
  readonly image: string;
  readonly unitName: string;
  readonly unitPath: string;
}

export interface InstanceStatus extends InstanceSummary {
  readonly systemd: SystemdUnitStatus;
}

export interface RemovePlan extends InstanceSummary {
  readonly confirmationToken: string;
  readonly dataPaths: readonly string[];
  readonly backupPath: string;
  readonly deleteData: boolean;
  readonly keepBackups: boolean;
}

export type PlannedAction =
  | 'create'
  | 'list'
  | 'start'
  | 'stop'
  | 'status'
  | 'upgrade'
  | 'rollback'
  | 'remove';

export interface InstanceOperationPlan {
  readonly action: PlannedAction;
  readonly topology: ManagedTopology | null;
  readonly instanceId: string | null;
  readonly generation: number | null;
  readonly version: string | null;
  readonly unitName: string | null;
  readonly unitPath: string | null;
  readonly configPath: string | null;
  readonly statePath: string | null;
  readonly runtimePath: string | null;
  readonly hostControlSocketPath: string | null;
  readonly containerControlSocketPath: string | null;
  readonly metadataPath: string | null;
  readonly backupPath: string | null;
  readonly evidencePaths: readonly string[];
  readonly volumeNames: readonly string[];
  readonly destructive: boolean;
}
