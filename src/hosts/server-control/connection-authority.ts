import {
  readTrustedTextFile,
  type TrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import { parseRelayHeadlessConfig } from '@hosts/relay/headless-config';
import { parseServerCoreCredentialDocument } from '@hosts/server-core/credential-file';

import type { ServerControlConfig } from './config';
import type { ServerConnectionSurface } from './connection-request';

export interface ManagedClientCredential {
  readonly credentialId: string;
  readonly surface: ServerConnectionSurface;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface LoadedConnectionAuthority {
  readonly authorityFile: TrustedTextFile;
  readonly authorizedKeysFile: TrustedTextFile;
  readonly records: readonly ManagedClientCredential[];
  readonly allCredentialIds: ReadonlySet<string>;
  readonly encode: (records: readonly ManagedClientCredential[]) => string;
}

function relayCredential(entry: ReturnType<typeof parseRelayHeadlessConfig>['credentials'][number]) {
  return {
    credentialId: entry.credentialId,
    instanceId: entry.instanceId,
    kind: entry.kind,
    publicKey: entry.publicKey,
    fingerprint: entry.fingerprint,
    status: entry.status,
    createdAt: entry.createdAt,
    revokedAt: entry.revokedAt,
  };
}

function loadRelay(
  config: ServerControlConfig,
  authorityFile: TrustedTextFile,
): Omit<LoadedConnectionAuthority, 'authorizedKeysFile' | 'authorityFile'> {
  const document = parseRelayHeadlessConfig(JSON.parse(authorityFile.text));
  if (document.instanceId !== config.instanceId) {
    throw new Error('Relay authority instance mismatch');
  }
  const records = document.credentials
    .filter((entry) => entry.kind !== 'relay-worker')
    .map((entry): ManagedClientCredential => Object.freeze({
      credentialId: entry.credentialId,
      surface: entry.kind === 'feishu' ? 'feishu' : 'desktop',
      publicKey: entry.publicKey,
      fingerprint: entry.fingerprint,
      status: entry.status,
      createdAt: entry.createdAt,
      revokedAt: entry.revokedAt,
    }));
  const encode = (next: readonly ManagedClientCredential[]): string => {
    const byId = new Map(next.map((entry) => [entry.credentialId, entry]));
    const emitted = new Set<string>();
    const credentials = document.credentials.map((entry) => {
      if (entry.kind === 'relay-worker') return relayCredential(entry);
      const replacement = byId.get(entry.credentialId);
      if (!replacement) throw new Error('connection authority cannot delete credential history');
      emitted.add(replacement.credentialId);
      return {
        credentialId: replacement.credentialId,
        instanceId: config.instanceId,
        kind: replacement.surface === 'feishu' ? 'feishu' : 'ssh-client',
        publicKey: replacement.publicKey,
        fingerprint: replacement.fingerprint,
        status: replacement.status,
        createdAt: replacement.createdAt,
        revokedAt: replacement.revokedAt,
      };
    });
    for (const entry of next) {
      if (emitted.has(entry.credentialId)) continue;
      credentials.push({
        credentialId: entry.credentialId,
        instanceId: config.instanceId,
        kind: entry.surface === 'feishu' ? 'feishu' : 'ssh-client',
        publicKey: entry.publicKey,
        fingerprint: entry.fingerprint,
        status: entry.status,
        createdAt: entry.createdAt,
        revokedAt: entry.revokedAt,
      });
    }
    const encoded = `${JSON.stringify({
      schemaVersion: 1,
      instanceId: document.instanceId,
      tickIntervalMs: document.tickIntervalMs,
      plumbingModule: document.plumbingModule,
      credentials,
    }, null, 2)}\n`;
    parseRelayHeadlessConfig(JSON.parse(encoded));
    return encoded;
  };
  return {
    records: Object.freeze(records),
    allCredentialIds: new Set(document.credentials.map((entry) => entry.credentialId)),
    encode,
  };
}

function loadFull(
  config: ServerControlConfig,
  authorityFile: TrustedTextFile,
): Omit<LoadedConnectionAuthority, 'authorizedKeysFile' | 'authorityFile'> {
  const document = parseServerCoreCredentialDocument(
    JSON.parse(authorityFile.text),
    config.instanceId,
  );
  const records = document.credentials.map((entry) => Object.freeze({ ...entry }));
  const encode = (next: readonly ManagedClientCredential[]): string => {
    const encoded = `${JSON.stringify({
      schemaVersion: 3,
      instanceId: document.instanceId,
      credentials: next,
    }, null, 2)}\n`;
    parseServerCoreCredentialDocument(JSON.parse(encoded), config.instanceId);
    return encoded;
  };
  return {
    records: Object.freeze(records),
    allCredentialIds: new Set(records.map((entry) => entry.credentialId)),
    encode,
  };
}

export function loadConnectionAuthority(config: ServerControlConfig): LoadedConnectionAuthority {
  const authorityFile = readTrustedTextFile(config.authorityFile);
  const authorizedKeysFile = readTrustedTextFile(config.authorizedKeysFile);
  if (authorityFile.mode !== 0o600 || authorizedKeysFile.mode !== 0o600) {
    throw new Error('connection authority files must be mode 0600');
  }
  const loaded = config.topology === 'relay'
    ? loadRelay(config, authorityFile)
    : loadFull(config, authorityFile);
  return Object.freeze({ authorityFile, authorizedKeysFile, ...loaded });
}

export function renderForcedClientKey(
  config: ServerControlConfig,
  record: Pick<ManagedClientCredential, 'credentialId' | 'publicKey' | 'surface'>,
): string {
  const forcedCommand = config.topology === 'relay'
    ? [
        '/opt/agent-deck/bin/agent-deck-relay bridge',
        `--instance ${config.instanceId}`,
        `--credential ${record.credentialId}`,
        `--surface ${record.surface}`,
        `--socket /run/user/${config.relayRuntimeUid}/agent-deck-relay/${config.instanceId}/control.sock`,
      ].join(' ')
    : [
        '/opt/agent-deck/bin/agent-deck-full-bridge',
        `--instance ${config.instanceId}`,
        `--credential ${record.credentialId}`,
        `--surface ${record.surface}`,
      ].join(' ');
  return [
    `restrict,command="${forcedCommand}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty`,
    record.publicKey,
  ].join(' ');
}

function lines(value: string): string[] {
  return value.split('\n').filter((line) => line.length > 0);
}

function isManagedClientLine(line: string, config: ServerControlConfig): boolean {
  const executable = config.topology === 'relay'
    ? '/opt/agent-deck/bin/agent-deck-relay bridge'
    : '/opt/agent-deck/bin/agent-deck-full-bridge';
  return line.includes(`command="${executable} `) &&
    line.includes(` --instance ${config.instanceId} `);
}

export function removeManagedCredentialLines(
  value: string,
  config: ServerControlConfig,
  credentialId: string,
): string {
  const kept = lines(value).filter((line) => !(
    isManagedClientLine(line, config) && line.includes(` --credential ${credentialId} `)
  ));
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

export function appendManagedLine(value: string, line: string): string {
  return `${value}${value.length > 0 && !value.endsWith('\n') ? '\n' : ''}${line}\n`;
}

export function verifyManagedAuthorizedKeys(
  authority: LoadedConnectionAuthority,
  config: ServerControlConfig,
): void {
  const actual = lines(authority.authorizedKeysFile.text)
    .filter((line) => isManagedClientLine(line, config));
  const expected = authority.records
    .filter((record) => record.status === 'active')
    .map((record) => renderForcedClientKey(config, record));
  if (
    actual.length !== expected.length ||
    [...actual].sort().some((line, index) => line !== [...expected].sort()[index])
  ) {
    throw new Error('managed authorized_keys entries differ from the connection authority');
  }
}
