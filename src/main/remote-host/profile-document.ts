import type { SshHostProfile } from '@clients/ssh';
import type { RemoteHostSourceMode } from '@shared/remote-host';
import {
  validateElectronHostProfile,
  type ElectronHostProfile,
} from '@hosts/electron';

export const REMOTE_HOST_PROFILE_SCHEMA_VERSION = 4;
const LEGACY_REMOTE_HOST_PROFILE_SCHEMA_VERSION = 3;
const MAX_PROFILES = 50;

export interface RemoteHostProfileDocument {
  schemaVersion: typeof REMOTE_HOST_PROFILE_SCHEMA_VERSION;
  sourceMode: RemoteHostSourceMode;
  selectedRemoteProfileId: string | null;
  profiles: ElectronHostProfile[];
}

export interface ParsedRemoteHostProfileDocument {
  document: RemoteHostProfileDocument;
  migrated: boolean;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid persisted remote host field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid persisted remote host field: ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, field);
}

function connectionCredentialStatus(
  value: unknown,
): 'refresh-required' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'refresh-required') return value;
  throw new Error('Invalid persisted remote host field: connectionCredentialStatus');
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid persisted remote host field: ${field}`);
  }
  return value as number;
}

function topology(value: unknown): ElectronHostProfile['topology'] {
  if (value === 'standalone' || value === 'relay' || value === 'full') return value;
  throw new Error('Invalid persisted remote host field: topology');
}

function parseSshProfile(
  raw: Record<string, unknown>,
  identity: { id: string; label: string; topology: 'full' | 'relay' },
): SshHostProfile {
  const ssh = record(raw.ssh, 'profile.ssh');
  const profile: SshHostProfile = {
    ...identity,
    hostname: text(ssh.hostname, 'profile.ssh.hostname'),
    port: positiveInteger(ssh.port, 'profile.ssh.port'),
    username: text(ssh.username, 'profile.ssh.username'),
    identityFile: text(ssh.identityFile, 'profile.ssh.identityFile'),
    knownHostsFile: text(ssh.knownHostsFile, 'profile.ssh.knownHostsFile'),
    ...(optionalText(ssh.expectedInstanceId, 'profile.ssh.expectedInstanceId')
      ? { expectedInstanceId: optionalText(ssh.expectedInstanceId, 'profile.ssh.expectedInstanceId') }
      : {}),
    ...(optionalText(ssh.expectedConnectionScope, 'profile.ssh.expectedConnectionScope')
      ? { expectedConnectionScope: optionalText(
          ssh.expectedConnectionScope,
          'profile.ssh.expectedConnectionScope',
        ) }
      : {}),
    ...(optionalText(ssh.hostKeyAlias, 'profile.ssh.hostKeyAlias')
      ? { hostKeyAlias: optionalText(ssh.hostKeyAlias, 'profile.ssh.hostKeyAlias') }
      : {}),
    ...(optionalText(ssh.hostKeyFingerprint, 'profile.ssh.hostKeyFingerprint')
      ? { hostKeyFingerprint: optionalText(
          ssh.hostKeyFingerprint,
          'profile.ssh.hostKeyFingerprint',
        ) }
      : {}),
  };
  return profile;
}

function parseProfile(value: unknown): ElectronHostProfile {
  const raw = record(value, 'profile');
  const id = text(raw.id, 'profile.id');
  const label = text(raw.label, 'profile.label');
  const clientId = text(raw.clientId, 'profile.clientId');
  const kind = topology(raw.topology);
  const profile: ElectronHostProfile = kind === 'standalone'
    ? { id, label, clientId, topology: kind }
    : {
        id,
        label,
        clientId,
        topology: kind,
        ...(connectionCredentialStatus(raw.connectionCredentialStatus)
          ? { connectionCredentialStatus: 'refresh-required' as const }
          : {}),
        ssh: parseSshProfile(raw, { id, label, topology: kind }),
      };
  validateElectronHostProfile(profile);
  return profile;
}

function migrateV3Profile(value: unknown): ElectronHostProfile {
  const raw = record(value, 'profile');
  const legacyTopology = raw.topology;
  const migratedTopology = legacyTopology === 'server-core' ? 'full' : legacyTopology;
  return parseProfile({
    ...raw,
    topology: migratedTopology,
    ...(migratedTopology === 'standalone'
      ? {}
      : { connectionCredentialStatus: 'refresh-required' }),
  });
}

function normalizeDocument(
  profiles: ElectronHostProfile[],
  sourceMode: RemoteHostSourceMode,
  selectedRemoteProfileId: string | null,
): RemoteHostProfileDocument {
  if (profiles.length === 0 || profiles.length > MAX_PROFILES) {
    throw new Error('Persisted remote host profile count is invalid');
  }
  const ids = profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) throw new Error('Persisted remote host profile ids are invalid');
  const standaloneCount = profiles.filter((profile) => profile.topology === 'standalone').length;
  if (standaloneCount !== 1) {
    throw new Error('Persisted remote host profiles require exactly one Standalone profile');
  }
  const selected = selectedRemoteProfileId === null
    ? null
    : profiles.find((profile) => profile.id === selectedRemoteProfileId) ?? null;
  if (selectedRemoteProfileId !== null && (!selected || selected.topology === 'standalone')) {
    throw new Error('Persisted remote host profile selection is invalid');
  }
  if (sourceMode !== 'local' && sourceMode !== 'remote') {
    throw new Error('Persisted remote host source mode is invalid');
  }
  if (sourceMode === 'remote' && !selected) {
    throw new Error('Remote source mode requires a selected remote profile');
  }
  return {
    schemaVersion: REMOTE_HOST_PROFILE_SCHEMA_VERSION,
    sourceMode,
    selectedRemoteProfileId,
    profiles,
  };
}

export function parseRemoteHostProfileDocument(
  value: unknown,
): ParsedRemoteHostProfileDocument {
  const raw = record(value, 'document');
  if (
    raw.schemaVersion !== REMOTE_HOST_PROFILE_SCHEMA_VERSION &&
    raw.schemaVersion !== LEGACY_REMOTE_HOST_PROFILE_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported persisted remote host profile schema');
  }
  if (!Array.isArray(raw.profiles)) throw new Error('Invalid persisted remote host profiles');
  const migrated = raw.schemaVersion === LEGACY_REMOTE_HOST_PROFILE_SCHEMA_VERSION;
  const sourceMode = text(raw.sourceMode, 'sourceMode') as RemoteHostSourceMode;
  return {
    document: normalizeDocument(
      raw.profiles.map(migrated ? migrateV3Profile : parseProfile),
      migrated ? 'local' : sourceMode,
      raw.selectedRemoteProfileId === null
        ? null
        : text(raw.selectedRemoteProfileId, 'selectedRemoteProfileId'),
    ),
    migrated,
  };
}

export function copyRemoteHostProfileDocument(
  document: RemoteHostProfileDocument,
): RemoteHostProfileDocument {
  return structuredClone(document);
}
