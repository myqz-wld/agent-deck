import { posix } from 'node:path';

import type { InstanceManagerRoots, ManagedTopology } from './types';
import { validateAbsoluteRoot, validateChildPath, validateInstanceId } from './validation';
import { fail } from './validation';

export interface InstancePaths {
  readonly topology: ManagedTopology;
  readonly instanceId: string;
  readonly configDirectory: string;
  readonly configFile: string;
  readonly stateDirectory: string | null;
  readonly runtimeDirectory: string;
  readonly unitPath: string;
  readonly unitName: string;
  readonly containerName: string;
  readonly hostControlSocketPath: string | null;
  readonly containerControlSocketPath: string;
  readonly metadataDirectory: string;
  readonly recordPath: string;
  readonly generationsDirectory: string;
  readonly backupDirectory: string;
  readonly evidenceDirectory: string;
  readonly cutoverEvidenceDirectory: string;
  readonly journalPath: string;
  readonly preflightPath: string;
  readonly templatePath: string;
}

const ROOT_FIELDS: readonly (keyof InstanceManagerRoots)[] = [
  'serviceHome',
  'runtimeRoot',
  'unitRoot',
  'metadataRoot',
  'backupRoot',
  'journalRoot',
  'cutoverEvidenceRoot',
  'fullTemplatePath',
  'fullPreflightPath',
  'relayTemplatePath',
  'relayPreflightPath',
  'relayEvidenceRoot',
];

export function validateConfiguredRoots(roots: InstanceManagerRoots): void {
  for (const field of ROOT_FIELDS) validateAbsoluteRoot(roots[field], `roots.${field}`);
}

export function resolveInstancePaths(
  roots: InstanceManagerRoots,
  topology: ManagedTopology,
  instanceId: string,
): InstancePaths {
  validateConfiguredRoots(roots);
  validateInstanceId(instanceId);
  const full = topology === 'full';
  const configDirectory = full
    ? posix.join(roots.serviceHome, '.config', 'agent-deck', 'instances', instanceId)
    : posix.join(roots.serviceHome, '.config', 'agent-deck-relay', instanceId);
  const stateDirectory = full
    ? null
    : posix.join(roots.serviceHome, '.local', 'share', 'agent-deck-relay', instanceId);
  const runtimeDirectory = posix.join(
    roots.runtimeRoot,
    full ? 'agent-deck' : 'agent-deck-relay',
    instanceId,
  );
  const unitStem = full ? 'agent-deck-full' : 'agent-deck-relay';
  const metadataDirectory = posix.join(roots.metadataRoot, topology, instanceId);
  const backupDirectory = posix.join(roots.backupRoot, topology, instanceId);
  const evidenceDirectory = full ? configDirectory : posix.join(roots.relayEvidenceRoot, instanceId);
  const cutoverEvidenceDirectory = posix.join(roots.cutoverEvidenceRoot, topology, instanceId);
  const journalPath = posix.join(roots.journalRoot, topology, `${instanceId}.journal.json`);
  const hostControlSocketPath = full ? null : posix.join(runtimeDirectory, 'control.sock');
  const containerControlSocketPath = full
    ? `/run/agent-deck/${instanceId}/agent-deckd.sock`
    : `/run/agent-deck-relay/${instanceId}/control.sock`;

  validateChildPath(configDirectory, roots.serviceHome, 'configDirectory');
  if (stateDirectory) validateChildPath(stateDirectory, roots.serviceHome, 'stateDirectory');
  validateChildPath(runtimeDirectory, roots.runtimeRoot, 'runtimeDirectory');
  validateChildPath(posix.join(roots.unitRoot, `${unitStem}@${instanceId}.container`), roots.unitRoot, 'unitPath');
  validateChildPath(metadataDirectory, roots.metadataRoot, 'metadataDirectory');
  validateChildPath(backupDirectory, roots.backupRoot, 'backupDirectory');
  validateChildPath(evidenceDirectory, full ? roots.serviceHome : roots.relayEvidenceRoot, 'evidenceDirectory');
  validateChildPath(cutoverEvidenceDirectory, roots.cutoverEvidenceRoot, 'cutoverEvidenceDirectory');
  validateChildPath(journalPath, roots.journalRoot, 'journalPath');
  if (
    (hostControlSocketPath && Buffer.byteLength(hostControlSocketPath) > 103) ||
    Buffer.byteLength(containerControlSocketPath) > 103
  ) {
    fail('invalid_input', 'instance control socket path exceeds the Unix socket byte limit');
  }

  return Object.freeze({
    topology,
    instanceId,
    configDirectory,
    configFile: posix.join(configDirectory, 'config.json'),
    stateDirectory,
    runtimeDirectory,
    unitPath: posix.join(roots.unitRoot, `${unitStem}@${instanceId}.container`),
    unitName: `${unitStem}@${instanceId}.service`,
    containerName: `${unitStem}-${instanceId}`,
    hostControlSocketPath,
    containerControlSocketPath,
    metadataDirectory,
    recordPath: posix.join(metadataDirectory, 'instance-record.json'),
    generationsDirectory: posix.join(metadataDirectory, 'generations'),
    backupDirectory,
    evidenceDirectory,
    cutoverEvidenceDirectory,
    journalPath,
    preflightPath: full ? roots.fullPreflightPath : roots.relayPreflightPath,
    templatePath: full ? roots.fullTemplatePath : roots.relayTemplatePath,
  });
}

export function generationPaths(paths: InstancePaths, version: string): {
  readonly directory: string;
  readonly unitPath: string;
  readonly configPath: string;
} {
  const directory = posix.join(paths.backupDirectory, version);
  return {
    directory,
    unitPath: posix.join(directory, paths.topology === 'full' ? 'agent-deck-full@.container' : 'agent-deck-relay@.container'),
    configPath: posix.join(directory, 'runtime-config.json'),
  };
}

export function fullVolumeNames(instanceId: string): readonly string[] {
  validateInstanceId(instanceId);
  return ['state', 'workspace', 'socket', 'browser', 'secrets'].map(
    (suffix) => `agent-deck-${instanceId}-${suffix}`,
  );
}
