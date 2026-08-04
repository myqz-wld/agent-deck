import { RelayMetadataError } from './metadata-fields';
import type {
  CredentialMetadata,
  RelayMetadataRows,
  RelayMetadataTable,
} from './metadata';

type Lookup = (
  table: RelayMetadataTable,
  id: string,
) => RelayMetadataRows[RelayMetadataTable] | null;

function requireInstance(instanceId: string, lookup: Lookup): void {
  const instance = lookup('instances', instanceId);
  if (!instance || instance.instanceId !== instanceId) {
    throw new RelayMetadataError(`Missing Relay instance foreign key: ${instanceId}`);
  }
}

function requireCredential(
  credentialId: string,
  instanceId: string,
  kinds: readonly CredentialMetadata['kind'][],
  lookup: Lookup,
): void {
  const credential = lookup('credentials', credentialId) as CredentialMetadata | null;
  if (
    !credential ||
    credential.instanceId !== instanceId ||
    !kinds.includes(credential.kind)
  ) {
    throw new RelayMetadataError(`Invalid credential foreign key: ${credentialId}`);
  }
}

export function assertRelayMetadataRelations<K extends RelayMetadataTable>(
  table: K,
  row: RelayMetadataRows[K],
  lookup: Lookup,
): void {
  if (table === 'instances') return;
  requireInstance(row.instanceId, lookup);
  if (table === 'credentials') return;
  if (table === 'workerRegistrations') {
    const registration = row as RelayMetadataRows['workerRegistrations'];
    requireCredential(registration.credentialId, registration.instanceId, ['relay-worker'], lookup);
    return;
  }
  if (table === 'routes') {
    const route = row as RelayMetadataRows['routes'];
    requireCredential(route.accessCredentialId, route.instanceId, ['ssh-client', 'feishu'], lookup);
    const registration = lookup('workerRegistrations', route.instanceId) as
      | RelayMetadataRows['workerRegistrations']
      | null;
    if (
      !registration ||
      (route.status === 'open' &&
        (registration.status !== 'online' ||
          registration.workerId !== route.workerId ||
          registration.generation !== route.generation))
    ) {
      throw new RelayMetadataError(`Invalid Worker foreign key for route: ${route.routeId}`);
    }
    return;
  }
  if (
    table === 'feishuContexts' ||
    table === 'feishuSubscriptions' ||
    table === 'feishuDeliveries' ||
    table === 'reconciliationCursors'
  ) {
    const feishu = row as
      | RelayMetadataRows['feishuContexts']
      | RelayMetadataRows['feishuSubscriptions']
      | RelayMetadataRows['feishuDeliveries']
      | RelayMetadataRows['reconciliationCursors'];
    requireCredential(feishu.credentialId, feishu.instanceId, ['feishu'], lookup);
  }
}
