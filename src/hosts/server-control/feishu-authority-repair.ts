import { RELAY_METADATA_TABLES, RelayMetadataStore } from '@hosts/relay/metadata';
import { commitManagedTextTransaction, readTrustedTextFile } from '@hosts/linux-runtime/connection-credential-issuer';
import { loadConnectionAuthority, verifyManagedAuthorizedKeys } from './connection-authority';
import type { ManagedClientCredential } from './connection-authority';
import type { ServerControlConfig } from './config';

/** Recover only missing Feishu history as revoked; never grant keys or edit Relay metadata. */
export function recoverFeishuAuthority(config: ServerControlConfig, metadataFile: string) {
  if (config.topology !== 'relay') throw new Error('Feishu history recovery requires Relay');
  const loaded = loadConnectionAuthority(config);
  verifyManagedAuthorizedKeys(loaded, config);
  const file = readTrustedTextFile(metadataFile);
  if (file.mode !== 0o600 || file.uid !== config.relayRuntimeUid || file.uid !== loaded.authorityFile.uid) {
    throw new Error('Relay metadata recovery owner/mode mismatch');
  }
  const metadata = RelayMetadataStore.fromSnapshot(file.text);
  for (const table of RELAY_METADATA_TABLES) {
    if (metadata.rows(table).some((row) => row.instanceId !== config.instanceId)) {
      throw new Error('Relay metadata recovery instance mismatch');
    }
  }
  const missing = metadata.rows('credentials').filter((row) => !loaded.allCredentialIds.has(row.credentialId));
  if (missing.some((row) => row.kind !== 'feishu')) {
    throw new Error('Recovery cannot alter non-Feishu credential history');
  }
  if (missing.length === 0) return { status: 'unchanged', restoredRevocations: 0 };
  const tombstones: ManagedClientCredential[] = missing.map((row) => ({
    credentialId: row.credentialId,
    surface: 'feishu',
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    status: 'revoked',
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? Math.max(Date.now(), row.createdAt),
  }));
  const records = [...loaded.records, ...tombstones];
  verifyManagedAuthorizedKeys({ ...loaded, records }, config);
  commitManagedTextTransaction({ mutations: [{
    current: loaded.authorityFile,
    next: loaded.encode(records),
  }] });
  return { status: 'recovered', restoredRevocations: tombstones.length };
}
