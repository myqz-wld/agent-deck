import {
  enumField,
  integerField,
  isRecord,
  linuxInstanceIdField,
  nullableStableTokenField,
  RelayMetadataError,
  stableTokenField,
  stringField,
} from './metadata-fields';
import { assertRelayMetadataRelations } from './metadata-relations';

export { RelayMetadataError } from './metadata-fields';

export const RELAY_METADATA_TABLES = [
  'instances',
  'credentials',
  'workerRegistrations',
  'routes',
  'feishuContexts',
  'feishuSubscriptions',
  'feishuDeliveries',
  'reconciliationCursors',
  'health',
] as const;

export type RelayMetadataTable = (typeof RELAY_METADATA_TABLES)[number];

export const RELAY_METADATA_ALLOWED_FIELDS = {
  instances: ['id', 'instanceId', 'topology', 'createdAt'],
  credentials: [
    'id',
    'instanceId',
    'credentialId',
    'kind',
    'publicKey',
    'fingerprint',
    'status',
    'createdAt',
    'revokedAt',
  ],
  workerRegistrations: [
    'id',
    'instanceId',
    'workerId',
    'credentialId',
    'generation',
    'status',
    'registeredAt',
    'lastSeenAt',
  ],
  routes: [
    'id',
    'instanceId',
    'routeId',
    'accessCredentialId',
    'accessSurface',
    'workerId',
    'generation',
    'status',
    'updatedAt',
  ],
  feishuContexts: [
    'id',
    'instanceId',
    'credentialId',
    'openId',
    'unionId',
    'chatId',
    'activeSessionId',
    'updatedAt',
  ],
  feishuSubscriptions: [
    'id',
    'instanceId',
    'credentialId',
    'chatId',
    'sessionId',
    'status',
    'updatedAt',
  ],
  feishuDeliveries: [
    'id',
    'instanceId',
    'eventId',
    'credentialId',
    'chatId',
    'status',
    'attempts',
    'updatedAt',
  ],
  reconciliationCursors: [
    'id',
    'instanceId',
    'credentialId',
    'chatId',
    'cursor',
    'updatedAt',
  ],
  health: ['id', 'instanceId', 'component', 'status', 'checkedAt', 'detailCode'],
} as const satisfies Record<RelayMetadataTable, readonly string[]>;

export const RELAY_METADATA_FORBIDDEN_TABLE_NAMES = [
  'approvals',
  'blobs',
  'browser',
  'cards',
  'diffs',
  'history',
  'messages',
  'providers',
  'repositories',
  'sessions',
  'worktrees',
] as const;

export const RELAY_METADATA_FORBIDDEN_FIELD_NAMES = [
  'approvalInput',
  'blob',
  'body',
  'cardBody',
  'content',
  'diff',
  'history',
  'message',
  'messageBody',
  'payload',
  'privateKey',
  'prompt',
  'providerState',
  'repositoryPath',
  'sessionDatabase',
] as const;

export interface InstanceMetadata {
  id: string;
  instanceId: string;
  topology: 'relay';
  createdAt: number;
}

export interface CredentialMetadata {
  id: string;
  instanceId: string;
  credentialId: string;
  kind: 'ssh-client' | 'feishu' | 'relay-worker';
  publicKey: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
}

export interface WorkerRegistrationMetadata {
  id: string;
  instanceId: string;
  workerId: string;
  credentialId: string;
  generation: number;
  status: 'online' | 'offline' | 'fenced';
  registeredAt: number;
  lastSeenAt: number;
}

export interface RouteMetadata {
  id: string;
  instanceId: string;
  routeId: string;
  accessCredentialId: string;
  accessSurface: 'desktop' | 'feishu';
  workerId: string;
  generation: number;
  status: 'open' | 'closed' | 'fenced';
  updatedAt: number;
}

export interface FeishuContextMetadata {
  id: string;
  instanceId: string;
  credentialId: string;
  openId: string;
  unionId: string | null;
  chatId: string;
  activeSessionId: string | null;
  updatedAt: number;
}

export interface FeishuSubscriptionMetadata {
  id: string;
  instanceId: string;
  credentialId: string;
  chatId: string;
  sessionId: string;
  status: 'active' | 'inactive';
  updatedAt: number;
}

export interface FeishuDeliveryMetadata {
  id: string;
  instanceId: string;
  eventId: string;
  credentialId: string;
  chatId: string;
  status: 'pending' | 'sent' | 'failed' | 'deduplicated' | 'reconciling';
  attempts: number;
  updatedAt: number;
}

export interface ReconciliationCursorMetadata {
  id: string;
  instanceId: string;
  credentialId: string;
  chatId: string;
  cursor: string;
  updatedAt: number;
}

export interface HealthMetadata {
  id: string;
  instanceId: string;
  component: 'relay' | 'worker-lease' | 'ssh-bridge' | 'feishu-gateway';
  status: 'ok' | 'degraded' | 'offline';
  checkedAt: number;
  detailCode: string | null;
}

export interface RelayMetadataRows {
  instances: InstanceMetadata;
  credentials: CredentialMetadata;
  workerRegistrations: WorkerRegistrationMetadata;
  routes: RouteMetadata;
  feishuContexts: FeishuContextMetadata;
  feishuSubscriptions: FeishuSubscriptionMetadata;
  feishuDeliveries: FeishuDeliveryMetadata;
  reconciliationCursors: ReconciliationCursorMetadata;
  health: HealthMetadata;
}

function assertKeys(table: RelayMetadataTable, row: Record<string, unknown>): void {
  const allowed = new Set<string>(RELAY_METADATA_ALLOWED_FIELDS[table]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new RelayMetadataError(`${table}.${key} is not in the Relay metadata allowlist`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) {
      throw new RelayMetadataError(`${table}.${key} is required`);
    }
  }
}

function common(table: RelayMetadataTable, row: Record<string, unknown>): void {
  assertKeys(table, row);
  stableTokenField(row, 'id');
  linuxInstanceIdField(row, 'instanceId');
}

const OPENSSH_PUBLIC_KEY = /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\s].*)?$/;

function validateRow(table: RelayMetadataTable, value: unknown): RelayMetadataRows[RelayMetadataTable] {
  if (!isRecord(value)) throw new RelayMetadataError(`${table} row must be an object`);
  common(table, value);
  switch (table) {
    case 'instances':
      if (value.id !== value.instanceId) {
        throw new RelayMetadataError('instances.id must equal instanceId');
      }
      enumField(value, 'topology', ['relay']);
      integerField(value, 'createdAt');
      break;
    case 'credentials': {
      const credentialId = stableTokenField(value, 'credentialId');
      if (value.id !== credentialId) {
        throw new RelayMetadataError('credentials.id must equal credentialId');
      }
      enumField(value, 'kind', ['ssh-client', 'feishu', 'relay-worker']);
      const publicKey = stringField(value, 'publicKey', 8192);
      if (!OPENSSH_PUBLIC_KEY.test(publicKey)) {
        throw new RelayMetadataError('credentials require one valid OpenSSH public key');
      }
      const fingerprint = stringField(value, 'fingerprint');
      if (!/^SHA256:[A-Za-z0-9+/=_-]+$/.test(fingerprint)) {
        throw new RelayMetadataError('fingerprint must use SHA256 token syntax');
      }
      const status = enumField(value, 'status', ['active', 'revoked']);
      const createdAt = integerField(value, 'createdAt');
      if (status === 'active' && value.revokedAt !== null) {
        throw new RelayMetadataError('Active credentials require null revokedAt');
      }
      if (status === 'revoked') {
        if (value.revokedAt === null) {
          throw new RelayMetadataError('Revoked credentials require revokedAt');
        }
        integerField(value, 'revokedAt', createdAt);
      }
      break;
    }
    case 'workerRegistrations': {
      if (value.id !== value.instanceId) {
        throw new RelayMetadataError('workerRegistrations.id must equal instanceId');
      }
      stableTokenField(value, 'workerId');
      stableTokenField(value, 'credentialId');
      integerField(value, 'generation', 1);
      enumField(value, 'status', ['online', 'offline', 'fenced']);
      const registeredAt = integerField(value, 'registeredAt');
      integerField(value, 'lastSeenAt', registeredAt);
      break;
    }
    case 'routes': {
      const routeId = stableTokenField(value, 'routeId');
      if (value.id !== routeId) {
        throw new RelayMetadataError('routes.id must equal routeId');
      }
      stableTokenField(value, 'accessCredentialId');
      enumField(value, 'accessSurface', ['desktop', 'feishu']);
      stableTokenField(value, 'workerId');
      integerField(value, 'generation', 1);
      enumField(value, 'status', ['open', 'closed', 'fenced']);
      integerField(value, 'updatedAt');
      break;
    }
    case 'feishuContexts':
      stableTokenField(value, 'credentialId');
      stableTokenField(value, 'openId');
      nullableStableTokenField(value, 'unionId');
      stableTokenField(value, 'chatId');
      nullableStableTokenField(value, 'activeSessionId');
      integerField(value, 'updatedAt');
      break;
    case 'feishuSubscriptions':
      stableTokenField(value, 'credentialId');
      stableTokenField(value, 'chatId');
      stableTokenField(value, 'sessionId');
      enumField(value, 'status', ['active', 'inactive']);
      integerField(value, 'updatedAt');
      break;
    case 'feishuDeliveries': {
      const eventId = stableTokenField(value, 'eventId');
      if (value.id !== eventId) {
        throw new RelayMetadataError('feishuDeliveries.id must equal eventId');
      }
      stableTokenField(value, 'credentialId');
      stableTokenField(value, 'chatId');
      enumField(value, 'status', ['pending', 'sent', 'failed', 'deduplicated', 'reconciling']);
      integerField(value, 'attempts');
      integerField(value, 'updatedAt');
      break;
    }
    case 'reconciliationCursors':
      stableTokenField(value, 'credentialId');
      stableTokenField(value, 'chatId');
      stringField(value, 'cursor', 2048);
      integerField(value, 'updatedAt');
      break;
    case 'health': {
      const component = enumField(value, 'component', [
        'relay',
        'worker-lease',
        'ssh-bridge',
        'feishu-gateway',
      ]);
      if (value.id !== component) {
        throw new RelayMetadataError('health.id must equal component');
      }
      enumField(value, 'status', ['ok', 'degraded', 'offline']);
      integerField(value, 'checkedAt');
      nullableStableTokenField(value, 'detailCode', 128);
      break;
    }
  }
  return value as unknown as RelayMetadataRows[RelayMetadataTable];
}

type MetadataArrays = { [K in RelayMetadataTable]: RelayMetadataRows[K][] };

function emptyTables(): MetadataArrays {
  return {
    instances: [],
    credentials: [],
    workerRegistrations: [],
    routes: [],
    feishuContexts: [],
    feishuSubscriptions: [],
    feishuDeliveries: [],
    reconciliationCursors: [],
    health: [],
  };
}

export class RelayMetadataStore {
  private readonly tables = emptyTables();
  private mutationObserver: (() => void) | null = null;

  setMutationObserver(observer: (() => void) | null): void {
    if (observer !== null && this.mutationObserver !== null) {
      throw new RelayMetadataError('Relay metadata mutation observer is already installed');
    }
    this.mutationObserver = observer;
  }

  put<K extends RelayMetadataTable>(table: K, value: unknown): RelayMetadataRows[K] {
    const row = validateRow(table, value) as RelayMetadataRows[K];
    assertRelayMetadataRelations(
      table,
      row,
      (relatedTable, id) => this.getById(relatedTable, id),
    );
    const rows = this.tables[table] as RelayMetadataRows[K][];
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    const copy = { ...row };
    if (index === -1) rows.push(copy);
    else rows[index] = copy;
    this.mutationObserver?.();
    return { ...copy };
  }

  getById<K extends RelayMetadataTable>(table: K, id: string): RelayMetadataRows[K] | null {
    const row = (this.tables[table] as RelayMetadataRows[K][]).find(
      (candidate) => candidate.id === id,
    );
    return row ? { ...row } : null;
  }

  credential(credentialId: string): CredentialMetadata | null {
    return this.getById('credentials', credentialId);
  }

  rows<K extends RelayMetadataTable>(table: K): RelayMetadataRows[K][] {
    return (this.tables[table] as RelayMetadataRows[K][]).map((row) => ({ ...row }));
  }

  exportSnapshot(): string {
    return JSON.stringify({ version: 2, tables: this.tables });
  }

  static fromSnapshot(snapshot: string): RelayMetadataStore {
    let decoded: unknown;
    try {
      decoded = JSON.parse(snapshot);
    } catch (error) {
      throw new RelayMetadataError(
        error instanceof Error ? error.message : 'Relay metadata snapshot is invalid JSON',
      );
    }
    if (!isRecord(decoded) || decoded.version !== 2 || !isRecord(decoded.tables)) {
      throw new RelayMetadataError('Relay metadata snapshot has an invalid envelope');
    }
    const envelopeFields = new Set(['version', 'tables']);
    for (const field of Object.keys(decoded)) {
      if (!envelopeFields.has(field)) {
        throw new RelayMetadataError(
          `snapshot.${field} is not in the Relay metadata envelope allowlist`,
        );
      }
    }
    const tableNames = new Set<string>(RELAY_METADATA_TABLES);
    for (const table of Object.keys(decoded.tables)) {
      if (!tableNames.has(table)) {
        throw new RelayMetadataError(`${table} is not an allowed Relay metadata table`);
      }
    }
    const store = new RelayMetadataStore();
    const primaryIds = new Map<RelayMetadataTable, Set<string>>(
      RELAY_METADATA_TABLES.map((table) => [table, new Set<string>()]),
    );
    for (const table of RELAY_METADATA_TABLES) {
      const rows = decoded.tables[table];
      if (!Array.isArray(rows)) throw new RelayMetadataError(`${table} must be an array`);
      for (const row of rows) {
        if (isRecord(row) && typeof row.id === 'string') {
          const ids = primaryIds.get(table) as Set<string>;
          if (ids.has(row.id)) {
            throw new RelayMetadataError(`Duplicate ${table} primary id in snapshot: ${row.id}`);
          }
          ids.add(row.id);
        }
        store.put(table, row);
      }
    }
    return store;
  }
}
