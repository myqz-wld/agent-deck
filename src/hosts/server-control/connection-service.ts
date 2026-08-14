import {
  commitManagedTextTransaction,
  prepareRemoteConnectionIssue,
  readTrustedTextFile,
  type CredentialIssueMutation,
  type PrivateTextOutput,
} from '@hosts/linux-runtime/connection-credential-issuer';
import { parseRemoteConnectionCredential } from '@shared/remote-host';

import {
  appendManagedLine,
  loadConnectionAuthority,
  removeManagedCredentialLines,
  renderForcedClientKey,
  verifyManagedAuthorizedKeys,
  type LoadedConnectionAuthority,
  type ManagedClientCredential,
} from './connection-authority';
import type { ServerControlConfig } from './config';
import type {
  IssueConnectionRequest,
  RevokeConnectionRequest,
  RotateConnectionRequest,
  ServerConnectionSurface,
} from './connection-request';

export interface ConnectionMutationResult {
  readonly status:
    | 'issued'
    | 'already-issued'
    | 'revoked'
    | 'already-revoked'
    | 'repaired-revocation'
    | 'rotated'
    | 'already-rotated';
  readonly topology: ServerControlConfig['topology'];
  readonly credentialId: string;
  readonly surface: ServerConnectionSurface;
  readonly outputFile?: string;
  readonly replacedCredentialId?: string;
}

export interface ConnectionListResult {
  readonly topology: ServerControlConfig['topology'];
  readonly instanceId: string;
  readonly credentials: ReadonlyArray<{
    readonly credentialId: string;
    readonly surface: ServerConnectionSurface;
    readonly fingerprint: string;
    readonly status: 'active' | 'revoked';
    readonly createdAt: number;
    readonly revokedAt: number | null;
  }>;
}

function outputOwner(config: ServerControlConfig, surface: ServerConnectionSurface) {
  return surface === 'feishu' ? config.feishuIdentityOwner : undefined;
}

function outputReady(
  path: string,
  config: ServerControlConfig,
  record: ManagedClientCredential,
): boolean {
  try {
    const output = readTrustedTextFile(path);
    const owner = outputOwner(config, record.surface) ?? {
      uid: typeof process.getuid === 'function' ? process.getuid() : output.uid,
      gid: typeof process.getgid === 'function' ? process.getgid() : output.gid,
    };
    if (
      output.mode !== 0o600 ||
      output.uid !== owner.uid || output.gid !== owner.gid
    ) return false;
    if (record.surface === 'feishu') {
      return /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n?$/u
        .test(output.text);
    }
    const credential = parseRemoteConnectionCredential(JSON.parse(output.text));
    return credential.purpose === 'client' &&
      credential.topology === config.topology &&
      credential.instanceId === config.instanceId &&
      credential.credentialId === record.credentialId;
  } catch {
    return false;
  }
}

function virtualAuthority(
  loaded: LoadedConnectionAuthority,
  records: readonly ManagedClientCredential[],
  authorizedKeys: string,
): LoadedConnectionAuthority {
  return {
    ...loaded,
    records,
    authorizedKeysFile: { ...loaded.authorizedKeysFile, text: authorizedKeys },
  };
}

function verifyNext(
  loaded: LoadedConnectionAuthority,
  config: ServerControlConfig,
  records: readonly ManagedClientCredential[],
  authorizedKeys: string,
): void {
  verifyManagedAuthorizedKeys(virtualAuthority(loaded, records, authorizedKeys), config);
}

export function commitServerConnectionTransaction(
  loaded: LoadedConnectionAuthority,
  authorityNext: string,
  authorizedKeysNext: string,
  outputs: readonly PrivateTextOutput[] = [],
  additionalMutations: readonly CredentialIssueMutation[] = [],
): void {
  const mutations: CredentialIssueMutation[] = [...additionalMutations];
  if (authorityNext !== loaded.authorityFile.text) {
    mutations.push({ current: loaded.authorityFile, next: authorityNext });
  }
  if (authorizedKeysNext !== loaded.authorizedKeysFile.text) {
    mutations.push({ current: loaded.authorizedKeysFile, next: authorizedKeysNext });
  }
  if (mutations.length === 0) return;
  commitManagedTextTransaction({
    mutations,
    ...(outputs.length > 0 ? { outputs } : {}),
  });
}

export function prepareServerConnectionRecord(input: {
  readonly config: ServerControlConfig;
  readonly credentialId: string;
  readonly surface: ServerConnectionSurface;
  readonly label: string;
  readonly outputFile: string;
  readonly now: number;
}) {
  const issue = prepareRemoteConnectionIssue({
    purpose: 'client',
    topology: input.config.topology,
    instanceId: input.config.instanceId,
    credentialId: input.credentialId,
    label: input.label,
    hostname: input.config.endpoint.hostname,
    port: input.config.endpoint.port,
    username: input.config.endpoint.username,
    hostKeyFile: input.config.endpoint.hostKeyFile,
    outputFile: input.outputFile,
  });
  const record: ManagedClientCredential = Object.freeze({
    credentialId: input.credentialId,
    surface: input.surface,
    publicKey: issue.publicKey,
    fingerprint: issue.fingerprint,
    status: 'active',
    createdAt: input.now,
    revokedAt: null,
  });
  return { issue, record };
}

export class ServerConnectionService {
  constructor(
    private readonly config: ServerControlConfig,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ConnectionListResult {
    const loaded = loadConnectionAuthority(this.config);
    return Object.freeze({
      topology: this.config.topology,
      instanceId: this.config.instanceId,
      credentials: Object.freeze(loaded.records.map((entry) => Object.freeze({
        credentialId: entry.credentialId,
        surface: entry.surface,
        fingerprint: entry.fingerprint,
        status: entry.status,
        createdAt: entry.createdAt,
        revokedAt: entry.revokedAt,
      }))),
    });
  }

  verify(): { readonly topology: ServerControlConfig['topology']; readonly active: number } {
    const loaded = loadConnectionAuthority(this.config);
    verifyManagedAuthorizedKeys(loaded, this.config);
    return Object.freeze({
      topology: this.config.topology,
      active: loaded.records.filter((entry) => entry.status === 'active').length,
    });
  }

  issue(request: IssueConnectionRequest): ConnectionMutationResult {
    const loaded = loadConnectionAuthority(this.config);
    const existing = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    if (existing) {
      if (
        existing.surface === request.surface && existing.status === 'active' &&
        outputReady(request.outputFile, this.config, existing)
      ) {
        verifyManagedAuthorizedKeys(loaded, this.config);
        return this.result('already-issued', existing, request.outputFile);
      }
      throw new Error('credentialId is already registered');
    }
    if (loaded.allCredentialIds.has(request.credentialId)) {
      throw new Error('credentialId belongs to a non-client connection');
    }
    const prepared = prepareServerConnectionRecord({
      config: this.config,
      credentialId: request.credentialId,
      surface: request.surface,
      label: request.label,
      outputFile: request.outputFile,
      now: this.now(),
    });
    const records = Object.freeze([...loaded.records, prepared.record]);
    const authorizedKeys = appendManagedLine(
      loaded.authorizedKeysFile.text,
      renderForcedClientKey(this.config, prepared.record),
    );
    verifyNext(loaded, this.config, records, authorizedKeys);
    commitServerConnectionTransaction(loaded, loaded.encode(records), authorizedKeys, [{
      path: request.outputFile,
      text: request.surface === 'desktop'
        ? prepared.issue.encodedCredential
        : prepared.issue.credential.identity.privateKey,
      mode: 0o600,
      ...outputOwner(this.config, request.surface),
    }]);
    this.verify();
    return this.result('issued', prepared.record, request.outputFile);
  }

  revoke(request: RevokeConnectionRequest): ConnectionMutationResult {
    const loaded = loadConnectionAuthority(this.config);
    const existing = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    if (!existing || existing.surface !== request.surface) {
      throw new Error('connection credential was not found for this surface');
    }
    const authorizedKeys = removeManagedCredentialLines(
      loaded.authorizedKeysFile.text,
      this.config,
      request.credentialId,
    );
    if (existing.status === 'revoked') {
      const status = authorizedKeys === loaded.authorizedKeysFile.text
        ? 'already-revoked'
        : 'repaired-revocation';
      verifyNext(loaded, this.config, loaded.records, authorizedKeys);
      commitServerConnectionTransaction(loaded, loaded.authorityFile.text, authorizedKeys);
      return this.result(status, existing);
    }
    const revoked = Object.freeze({
      ...existing,
      status: 'revoked' as const,
      revokedAt: Math.max(this.now(), existing.createdAt),
    });
    const records = Object.freeze(loaded.records.map((entry) =>
      entry.credentialId === request.credentialId ? revoked : entry));
    verifyNext(loaded, this.config, records, authorizedKeys);
    commitServerConnectionTransaction(loaded, loaded.encode(records), authorizedKeys);
    this.verify();
    return this.result('revoked', revoked);
  }

  rotate(request: RotateConnectionRequest): ConnectionMutationResult {
    const loaded = loadConnectionAuthority(this.config);
    const current = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    const next = loaded.records.find((entry) => entry.credentialId === request.nextCredentialId);
    if (current?.status === 'revoked' && next?.status === 'active') {
      if (
        current.surface === request.surface && next.surface === request.surface &&
        outputReady(request.outputFile, this.config, next)
      ) {
        verifyManagedAuthorizedKeys(loaded, this.config);
        return this.result('already-rotated', next, request.outputFile, current.credentialId);
      }
      throw new Error('rotation already completed without the requested trusted output');
    }
    if (!current || current.surface !== request.surface || current.status !== 'active') {
      throw new Error('active rotation source was not found for this surface');
    }
    if (loaded.allCredentialIds.has(request.nextCredentialId)) {
      throw new Error('nextCredentialId is already registered');
    }
    const now = this.now();
    const prepared = prepareServerConnectionRecord({
      config: this.config,
      credentialId: request.nextCredentialId,
      surface: request.surface,
      label: request.label,
      outputFile: request.outputFile,
      now,
    });
    const records = Object.freeze([
      ...loaded.records.map((entry) => entry.credentialId === current.credentialId
        ? Object.freeze({ ...entry, status: 'revoked' as const, revokedAt: now })
        : entry),
      prepared.record,
    ]);
    const withoutCurrent = removeManagedCredentialLines(
      loaded.authorizedKeysFile.text,
      this.config,
      current.credentialId,
    );
    const authorizedKeys = appendManagedLine(
      withoutCurrent,
      renderForcedClientKey(this.config, prepared.record),
    );
    verifyNext(loaded, this.config, records, authorizedKeys);
    commitServerConnectionTransaction(loaded, loaded.encode(records), authorizedKeys, [{
      path: request.outputFile,
      text: request.surface === 'desktop'
        ? prepared.issue.encodedCredential
        : prepared.issue.credential.identity.privateKey,
      mode: 0o600,
      ...outputOwner(this.config, request.surface),
    }]);
    this.verify();
    return this.result('rotated', prepared.record, request.outputFile, current.credentialId);
  }

  private result(
    status: ConnectionMutationResult['status'],
    record: ManagedClientCredential,
    outputFile?: string,
    replacedCredentialId?: string,
  ): ConnectionMutationResult {
    return Object.freeze({
      status,
      topology: this.config.topology,
      credentialId: record.credentialId,
      surface: record.surface,
      ...(outputFile ? { outputFile } : {}),
      ...(replacedCredentialId ? { replacedCredentialId } : {}),
    });
  }
}
