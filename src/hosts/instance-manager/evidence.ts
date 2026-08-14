import { posix } from 'node:path';

import { captureTrustedFile, requireCanonicalDirectory, requireCanonicalFile, requireOwnedDirectory } from './artifacts';
import type { InstancePaths } from './paths';
import { fullVolumeNames } from './paths';
import { decodeUtf8 } from './serialization';
import type {
  ClockPort,
  FileSystemPort,
  ManagedTopology,
  ManagedVersion,
  TrustedFileArtifact,
} from './types';
import { fail, sameFileSnapshot } from './validation';

const MAX_EVIDENCE_BYTES = 8_192;

function exactLines(bytes: Uint8Array, expected: readonly string[], field: string): void {
  const text = decodeUtf8(bytes, field);
  if (!text.endsWith('\n') || text.includes('\r')) fail('tampered', `${field} has invalid line endings`);
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    fail('tampered', `${field} has missing, duplicated, reordered, or extra evidence`);
  }
}

async function readEvidence(input: {
  fileSystem: FileSystemPort;
  clock: ClockPort;
  path: string;
  expectedUid: number;
  maxAgeMs: number;
  expectedLines: readonly string[];
  field: string;
}): Promise<TrustedFileArtifact> {
  const artifact = await requireCanonicalFile(input.fileSystem, input.path, MAX_EVIDENCE_BYTES, input.field);
  if (artifact.identity.uid !== input.expectedUid || (artifact.identity.mode & 0o777) !== 0o444) {
    fail('tampered', `${input.field} must have the exact trusted owner and mode 0444`);
  }
  const age = input.clock.nowMs() - artifact.identity.modifiedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > input.maxAgeMs) fail('tampered', `${input.field} is stale or future-dated`);
  exactLines(artifact.bytes, input.expectedLines, input.field);
  return captureTrustedFile(input.fileSystem, input.path, MAX_EVIDENCE_BYTES, input.expectedUid, 0o444, input.field);
}

function runtimeFull(paths: InstancePaths): readonly { path: string; lines: readonly string[]; field: string }[] {
  const [state, workspace, socket, browser, secrets] = fullVolumeNames(paths.instanceId);
  return [
    { path: posix.join(paths.evidenceDirectory, 'egress-policy.verified'), field: 'full egress evidence', lines: ['schemaVersion=1', `instanceId=${paths.instanceId}`, 'topology=full', 'publicOnlyEgressVerified=true', 'privateAndLinkLocalDenied=true', 'cloudMetadataDenied=true'] },
    { path: posix.join(paths.evidenceDirectory, 'volume-quota.verified'), field: 'full quota evidence', lines: ['schemaVersion=1', `instanceId=${paths.instanceId}`, 'topology=full', `stateVolume=${state}`, `workspaceVolume=${workspace}`, `socketVolume=${socket}`, `browserVolume=${browser}`, `secretsVolume=${secrets}`, 'volumeQuotaEnforced=true'] },
  ];
}

async function runtimeRelay(fileSystem: FileSystemPort, paths: InstancePaths): Promise<readonly { path: string; lines: readonly string[]; field: string }[]> {
  if (!paths.stateDirectory) fail('tampered', 'relay state path is missing');
  const stateReal = await fileSystem.realpath(paths.stateDirectory);
  if (stateReal !== paths.stateDirectory) fail('tampered', 'relay state path uses symlink indirection');
  return [
    { path: posix.join(paths.evidenceDirectory, 'egress.env'), field: 'relay egress evidence', lines: ['schemaVersion=1', `instanceId=${paths.instanceId}`, 'publicOnlyEgressVerified=true', 'privateAndLinkLocalDenied=true', 'cloudMetadataDenied=true'] },
    { path: posix.join(paths.evidenceDirectory, 'quota.env'), field: 'relay quota evidence', lines: ['schemaVersion=1', `instanceId=${paths.instanceId}`, `statePath=${stateReal}`, 'stateQuotaEnforced=true', 'stateQuotaBytes=1073741824'] },
  ];
}

function exactCutover(input: {
  topology: ManagedTopology;
  paths: InstancePaths;
  generation: number;
  version: ManagedVersion;
}): readonly { path: string; lines: readonly string[]; field: string }[] {
  const generationDirectory = posix.join(input.paths.cutoverEvidenceDirectory, `${input.generation}-${input.version.version}`);
  const common = [
    'schemaVersion=2',
    `topology=${input.topology}`,
    `instanceId=${input.paths.instanceId}`,
    `generation=${input.generation}`,
    `version=${input.version.version}`,
    `image=${input.version.image}`,
    `unitSha256=${input.version.unitSha256}`,
  ];
  const network = input.topology === 'full'
    ? [`networkName=agent-deck-${input.paths.instanceId}-egress`, 'networkPolicy=public-dns-http-https-only']
    : ['networkName=slirp4netns:allow_host_loopback=false', 'networkPolicy=public-only-private-linklocal-metadata-denied'];
  const quota = input.version.fullResources
    ? [
        `cpuCores=${input.version.fullResources.cpuCores.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`,
        `memoryBytes=${input.version.fullResources.memoryBytes}`,
        `pids=${input.version.fullResources.pids}`,
        `rootfsBytes=${input.version.fullResources.rootfsBytes}`,
        `tmpfsBytes=${input.version.fullResources.tmpfsBytes}`,
        `logBytes=${input.version.fullResources.logBytes}`,
        `volumes=${fullVolumeNames(input.paths.instanceId).join(',')}`,
      ]
    : [`statePath=${input.paths.stateDirectory}`, 'stateQuotaBytes=1073741824'];
  return [
    { path: posix.join(generationDirectory, 'egress.env'), field: 'exact cutover egress evidence', lines: [...common, ...network, 'egressVerified=true'] },
    { path: posix.join(generationDirectory, 'quota.env'), field: 'exact cutover quota evidence', lines: [...common, ...quota, 'quotaVerified=true'] },
  ];
}

export async function validateStartEvidence(input: {
  readonly topology: ManagedTopology;
  readonly paths: InstancePaths;
  readonly generation: number;
  readonly version: ManagedVersion;
  readonly fileSystem: FileSystemPort;
  readonly clock: ClockPort;
  readonly serviceUid: number;
  readonly trustedRootUid: number;
  readonly maxAgeMs: number;
}): Promise<readonly TrustedFileArtifact[]> {
  if (input.topology === 'relay') await requireOwnedDirectory(input.fileSystem, input.paths.evidenceDirectory, input.trustedRootUid, 0o555, 'relay evidence directory');
  const runtime = input.topology === 'full' ? runtimeFull(input.paths) : await runtimeRelay(input.fileSystem, input.paths);
  const snapshots: TrustedFileArtifact[] = [];
  for (const entry of runtime) snapshots.push(await readEvidence({ ...input, expectedUid: input.topology === 'full' ? input.serviceUid : input.trustedRootUid, expectedLines: entry.lines, path: entry.path, field: entry.field }));
  const directory = await requireCanonicalDirectory(input.fileSystem, input.paths.cutoverEvidenceDirectory, 'exact cutover evidence directory');
  if (directory.uid !== input.trustedRootUid || (directory.mode & 0o777) !== 0o555) fail('tampered', 'exact cutover evidence directory has an untrusted owner or mode');
  const exact = exactCutover(input);
  await requireOwnedDirectory(input.fileSystem, posix.dirname(input.paths.cutoverEvidenceDirectory), input.trustedRootUid, 0o555, 'topology evidence directory');
  const generationDirectory = await requireCanonicalDirectory(input.fileSystem, posix.dirname(exact[0].path), 'generation evidence directory');
  if (generationDirectory.uid !== input.trustedRootUid || (generationDirectory.mode & 0o777) !== 0o555) fail('tampered', 'generation evidence directory has an untrusted owner or mode');
  for (const entry of exact) snapshots.push(await readEvidence({ ...input, expectedUid: input.trustedRootUid, expectedLines: entry.lines, path: entry.path, field: entry.field }));
  return snapshots;
}

export async function revalidateEvidence(
  fileSystem: FileSystemPort,
  snapshots: readonly TrustedFileArtifact[],
  clock: ClockPort,
  maxAgeMs: number,
): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await fileSystem.lstat(snapshot.path);
    if (!current || !sameFileSnapshot(current, snapshot.identity)) fail('tampered', 'cutover evidence changed after validation');
    const age = clock.nowMs() - current.modifiedAtMs;
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) fail('tampered', 'cutover evidence expired during validation');
    const bytes = await fileSystem.readFile(snapshot.path, MAX_EVIDENCE_BYTES);
    const repeated = await captureTrustedFile(fileSystem, snapshot.path, MAX_EVIDENCE_BYTES, snapshot.identity.uid, snapshot.identity.mode & 0o777, 'cutover evidence recheck');
    if (repeated.sha256 !== snapshot.sha256 || bytes.byteLength !== snapshot.identity.size) fail('tampered', 'cutover evidence content changed after validation');
  }
}

export function evidencePaths(topology: ManagedTopology, paths: InstancePaths, generation?: number, version?: string): readonly string[] {
  const runtime = topology === 'full'
    ? [posix.join(paths.evidenceDirectory, 'egress-policy.verified'), posix.join(paths.evidenceDirectory, 'volume-quota.verified')]
    : [posix.join(paths.evidenceDirectory, 'egress.env'), posix.join(paths.evidenceDirectory, 'quota.env')];
  if (generation === undefined || version === undefined) return runtime;
  const exactRoot = posix.join(paths.cutoverEvidenceDirectory, `${generation}-${version}`);
  return [...runtime, posix.join(exactRoot, 'egress.env'), posix.join(exactRoot, 'quota.env')];
}
