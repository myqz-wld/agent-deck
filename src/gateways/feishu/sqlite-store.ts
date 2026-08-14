import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  FeishuGatewayError,
  type DeliveryClaim,
  type EnrolledFeishuCredential,
  type FeishuChatContext,
  type FeishuCursorRecord,
  type FeishuDeliveryRecord,
  type FeishuGatewayBinding,
  type FeishuGatewayStore,
  type FeishuSessionDeleteConfirmation,
  type FeishuStableSubject,
  type FeishuSubscriptionRecord,
} from '@gateways/im';
import { initializeFeishuMetadataSchema } from './sqlite-schema';
import {
  SqliteFeishuDeliveryStore,
  type SqliteDeliveryInput,
} from './sqlite-delivery-store';
import { SqliteFeishuDeleteConfirmationStore } from './sqlite-delete-confirmation-store';
import { SqliteFeishuPairingStore } from './sqlite-pairing-store';
import { validateFeishuConnectionHealth } from './health';
import type {
  FeishuConfiguredCredential,
  FeishuConnectionHealth,
  FeishuHealthStore,
  FeishuPairingCodeRecord,
  FeishuPairingRequestRecord,
  FeishuPairingStore,
} from './types';

function secureDatabaseFile(path: string): void {
  let descriptor: number | null = null;
  try {
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (descriptor !== null) closeSync(descriptor);
    descriptor = null;
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600
    ) throw new Error('untrusted');
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Feishu metadata database file could not be verified',
    );
  }
}

function credential(row: Record<string, unknown>): EnrolledFeishuCredential {
  return {
    appId: row.app_id as string,
    tenantKey: row.tenant_key as string,
    openId: row.open_id as string,
    instanceId: row.instance_id as string,
    credentialId: row.credential_id as string,
    connectionScope: row.connection_scope as string,
    topology: row.topology as EnrolledFeishuCredential['topology'],
    status: row.status as EnrolledFeishuCredential['status'],
    authority: 'owner-equivalent',
  };
}

export class SqliteFeishuGatewayStore implements
FeishuGatewayStore, FeishuHealthStore, FeishuPairingStore {
  private readonly db: Database.Database;
  private readonly deliveryStore: SqliteFeishuDeliveryStore;
  private readonly deleteConfirmationStore: SqliteFeishuDeleteConfirmationStore;
  private readonly pairingStore: SqliteFeishuPairingStore;

  constructor(
    databasePath: string,
    private readonly binding: FeishuGatewayBinding,
  ) {
    secureDatabaseFile(databasePath);
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 250');
    this.db.pragma('trusted_schema = OFF');
    try {
      initializeFeishuMetadataSchema(this.db);
      const integrity = this.db.pragma('quick_check(1)', { simple: true });
      const foreignKeys = this.db.pragma('foreign_key_check') as unknown[];
      if (integrity !== 'ok' || foreignKeys.length !== 0) {
        throw new FeishuGatewayError(
          'invalid_configuration',
          'Feishu metadata database integrity could not be verified',
        );
      }
      this.deliveryStore = new SqliteFeishuDeliveryStore(this.db);
      this.deleteConfirmationStore = new SqliteFeishuDeleteConfirmationStore(this.db);
      this.pairingStore = new SqliteFeishuPairingStore(this.db, this.binding);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  reconcileCredentials(configured: readonly FeishuConfiguredCredential[]): void {
    this.db.transaction(() => {
      const foreignState = this.db.prepare(`
        SELECT instance_id FROM contexts WHERE instance_id != ?
        UNION SELECT instance_id FROM deliveries WHERE instance_id != ?
        UNION SELECT instance_id FROM cursors WHERE instance_id != ?
        UNION SELECT instance_id FROM health WHERE instance_id != ?
        UNION SELECT instance_id FROM pairing_codes WHERE instance_id != ?
        UNION SELECT instance_id FROM pairing_requests WHERE instance_id != ?
        UNION SELECT instance_id FROM delete_confirmations WHERE instance_id != ?
        LIMIT 1
      `).get(
        this.binding.instanceId,
        this.binding.instanceId,
        this.binding.instanceId,
        this.binding.instanceId,
        this.binding.instanceId,
        this.binding.instanceId,
        this.binding.instanceId,
      );
      if (foreignState) {
        throw new FeishuGatewayError('invalid_configuration', 'Stored instance binding is invalid');
      }
      let rows = this.db.prepare(`SELECT * FROM credentials`).all() as Record<string, unknown>[];
      if (rows.some((row) =>
        row.app_id !== this.binding.appId || row.tenant_key !== this.binding.tenantKey ||
        row.instance_id !== this.binding.instanceId || row.topology !== this.binding.topology
      )) throw new FeishuGatewayError('invalid_configuration', 'Stored credential binding is invalid');
      this.rotateConfiguredCredential(rows, configured);
      rows = this.db.prepare(`SELECT * FROM credentials`).all() as Record<string, unknown>[];
      const configuredIds = new Set(configured.map((item) => item.credentialId));
      for (const row of rows) {
        if (!configuredIds.has(row.credential_id as string)) {
          this.revoke(row.credential_id as string);
        }
      }
      for (const item of configured) this.upsertCredential(item);
    }).immediate();
  }

  private rotateConfiguredCredential(
    rows: readonly Record<string, unknown>[],
    configured: readonly FeishuConfiguredCredential[],
  ): void {
    if (configured.length !== 1 || configured[0]?.status !== 'active') return;
    const next = configured[0];
    if (rows.some((row) => row.credential_id === next.credentialId)) return;
    const active = rows.filter((row) => row.status === 'active');
    if (active.length !== 1) return;
    const current = active[0];
    if (
      next.replacesCredentialId !== current.credential_id ||
      next.openId !== current.open_id
    ) {
      throw new FeishuGatewayError(
        'identity_conflict',
        'Credential replacement does not match the durable active identity',
      );
    }
    this.db.prepare(`
      UPDATE credentials SET credential_id = ?, connection_scope = ?
      WHERE instance_id = ? AND credential_id = ? AND status = 'active'
    `).run(
      next.credentialId,
      next.connectionScope,
      this.binding.instanceId,
      current.credential_id,
    );
    this.db.prepare(`
      UPDATE deliveries SET credential_id = ?
      WHERE instance_id = ? AND credential_id = ?
    `).run(next.credentialId, this.binding.instanceId, current.credential_id);
    this.db.prepare(`
      UPDATE pairing_requests SET credential_id = ?
      WHERE instance_id = ? AND credential_id = ?
    `).run(next.credentialId, this.binding.instanceId, current.credential_id);
  }

  private upsertCredential(item: FeishuConfiguredCredential): void {
    const byIdentity = item.openId === null ? null : this.resolveCredential({
      appId: this.binding.appId, tenantKey: this.binding.tenantKey, openId: item.openId,
    });
    const byId = this.db.prepare(
      `SELECT * FROM credentials WHERE instance_id = ? AND credential_id = ?`,
    ).get(this.binding.instanceId, item.credentialId) as Record<string, unknown> | undefined;
    if (
      (byIdentity && (
        byIdentity.credentialId !== item.credentialId ||
        byIdentity.connectionScope !== item.connectionScope
      )) ||
      (byId && (
        (item.openId !== null && byId.open_id !== null && byId.open_id !== item.openId) ||
        byId.connection_scope !== item.connectionScope
      ))
    ) throw new FeishuGatewayError('identity_conflict', 'Credential enrollment conflicts with durable identity');
    this.db.prepare(`
      INSERT INTO credentials (
        app_id, tenant_key, open_id, instance_id, credential_id, connection_scope,
        topology, status, authority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-equivalent')
      ON CONFLICT(instance_id, credential_id) DO UPDATE SET
        open_id = CASE WHEN excluded.open_id IS NULL THEN credentials.open_id ELSE excluded.open_id END,
        status = excluded.status
    `).run(
      this.binding.appId,
      this.binding.tenantKey,
      item.openId,
      this.binding.instanceId,
      item.credentialId,
      item.connectionScope,
      this.binding.topology,
      item.status,
    );
    if (item.status === 'revoked') this.revoke(item.credentialId);
  }

  private revoke(credentialId: string): void {
    this.db.prepare(
      `UPDATE credentials SET status = 'revoked' WHERE instance_id = ? AND credential_id = ?`,
    ).run(this.binding.instanceId, credentialId);
    this.db.prepare(
      `DELETE FROM contexts WHERE instance_id = ? AND credential_id = ?`,
    ).run(this.binding.instanceId, credentialId);
  }

  resolveCredential(subject: FeishuStableSubject): EnrolledFeishuCredential | null {
    const row = this.db.prepare(`
      SELECT * FROM credentials WHERE app_id = ? AND tenant_key = ? AND open_id = ?
    `).get(subject.appId, subject.tenantKey, subject.openId) as Record<string, unknown> | undefined;
    return row ? credential(row) : null;
  }

  listActiveCredentials(): readonly EnrolledFeishuCredential[] {
    return (this.db.prepare(
      `SELECT * FROM credentials WHERE status = 'active' AND open_id IS NOT NULL ORDER BY credential_id`,
    ).all() as Record<string, unknown>[]).map(credential);
  }

  getContext(instanceId: string, credentialId: string, chatId: string): FeishuChatContext | null {
    const row = this.db.prepare(`
      SELECT * FROM contexts WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
    `).get(instanceId, credentialId, chatId) as Record<string, unknown> | undefined;
    return row ? {
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      chatType: row.chat_type as FeishuChatContext['chatType'],
      openId: row.open_id as string,
      activeSessionId: row.active_session_id as string | null,
      updatedAt: row.updated_at as number,
    } : null;
  }

  listContexts(): readonly FeishuChatContext[] {
    return (this.db.prepare(`SELECT * FROM contexts ORDER BY credential_id, chat_id`).all() as
      Record<string, unknown>[]).map((row) => ({
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      chatType: row.chat_type as FeishuChatContext['chatType'],
      openId: row.open_id as string,
      activeSessionId: row.active_session_id as string | null,
      updatedAt: row.updated_at as number,
    }));
  }

  putContext(value: FeishuChatContext): void {
    this.db.prepare(`
      INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, credential_id, chat_id) DO UPDATE SET
        open_id = excluded.open_id,
        active_session_id = excluded.active_session_id,
        updated_at = excluded.updated_at,
        chat_type = excluded.chat_type
    `).run(
      value.instanceId, value.credentialId, value.chatId, value.openId,
      value.activeSessionId, value.updatedAt, value.chatType,
    );
  }

  getSubscription(
    instanceId: string,
    credentialId: string,
    chatId: string,
    sessionId: string,
  ): FeishuSubscriptionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE instance_id = ? AND credential_id = ? AND chat_id = ? AND session_id = ?
    `).get(instanceId, credentialId, chatId, sessionId) as Record<string, unknown> | undefined;
    return row ? this.toSubscription(row) : null;
  }

  listSubscriptions(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): readonly FeishuSubscriptionRecord[] {
    return (this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE instance_id = ? AND credential_id = ? AND chat_id = ? ORDER BY session_id
    `).all(instanceId, credentialId, chatId) as Record<string, unknown>[])
      .map((row) => this.toSubscription(row));
  }

  private toSubscription(row: Record<string, unknown>): FeishuSubscriptionRecord {
    return {
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      sessionId: row.session_id as string,
      status: row.status as FeishuSubscriptionRecord['status'],
      updatedAt: row.updated_at as number,
    };
  }

  putSubscription(value: FeishuSubscriptionRecord): void {
    this.db.prepare(`
      INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, credential_id, chat_id, session_id) DO UPDATE SET
        status = excluded.status, updated_at = excluded.updated_at
    `).run(
      value.instanceId, value.credentialId, value.chatId,
      value.sessionId, value.status, value.updatedAt,
    );
  }

  claimDelivery(input: SqliteDeliveryInput, maximum: number, lifetimeMs = 30_000): DeliveryClaim {
    return this.deliveryStore.claim(input, maximum, lifetimeMs);
  }

  markDeliveryPreTransport(i: string, e: string, a: number, u: number): boolean {
    return this.deliveryStore.markPreTransport(i, e, a, u);
  }

  markDeliveryTransportInvoked(
    i: string,
    e: string,
    a: number,
    safety: 'safe' | 'unknown',
    expiresAt: number | null,
    u: number,
  ): boolean {
    return this.deliveryStore.markTransportInvoked(i, e, a, safety, expiresAt, u);
  }

  markDeliveryNotAccepted(i: string, e: string, a: number, u: number): boolean {
    return this.deliveryStore.markNotAccepted(i, e, a, u);
  }

  finishDelivery(
    i: string,
    e: string,
    a: number,
    status: 'failed' | 'reconciling' | 'sent',
    u: number,
  ): boolean {
    return this.deliveryStore.finish(i, e, a, status, u);
  }

  getDelivery(instanceId: string, eventId: string): FeishuDeliveryRecord | null {
    return this.deliveryStore.get(instanceId, eventId);
  }

  requireDeliveryReconciliation(i: string, e: string, a: number, u: number): boolean {
    return this.deliveryStore.requireReconciliation(i, e, a, u);
  }

  getCursor(i: string, c: string, chat: string): FeishuCursorRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM cursors WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
    `).get(i, c, chat) as Record<string, unknown> | undefined;
    return row ? {
      instanceId: row.instance_id as string,
      credentialId: row.credential_id as string,
      chatId: row.chat_id as string,
      revision: row.revision as number,
      updatedAt: row.updated_at as number,
    } : null;
  }

  putCursor(value: FeishuCursorRecord): void {
    this.db.transaction(() => {
      const current = this.getCursor(value.instanceId, value.credentialId, value.chatId);
      if (current && value.revision < current.revision) {
        throw new FeishuGatewayError('cursor_regression', 'Feishu cursor cannot move backwards');
      }
      this.db.prepare(`
        INSERT INTO cursors VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, credential_id, chat_id) DO UPDATE SET
          revision = excluded.revision, updated_at = excluded.updated_at
      `).run(
        value.instanceId, value.credentialId, value.chatId, value.revision, value.updatedAt,
      );
    }).immediate();
  }

  createDeleteConfirmation(value: FeishuSessionDeleteConfirmation) {
    return this.deleteConfirmationStore.create(value);
  }

  claimDeleteConfirmation(input: Parameters<FeishuGatewayStore['claimDeleteConfirmation']>[0]) {
    return this.deleteConfirmationStore.claim(input);
  }

  releaseDeleteConfirmation(i: string, c: string, e: string, at: number): boolean {
    return this.deleteConfirmationStore.release(i, c, e, at);
  }

  completeDeleteConfirmation(i: string, c: string, e: string, at: number): boolean {
    return this.deleteConfirmationStore.complete(i, c, e, at);
  }

  getDeleteConfirmation(instanceId: string, confirmationId: string) {
    return this.deleteConfirmationStore.get(instanceId, confirmationId);
  }

  pruneDeleteConfirmations(terminalBefore: number, now: number): number {
    return this.deleteConfirmationStore.prune(terminalBefore, now);
  }

  createPairingCode(value: FeishuPairingCodeRecord) {
    return this.pairingStore.createPairingCode(value);
  }

  consumePairingCode(input: Parameters<FeishuPairingStore['consumePairingCode']>[0]) {
    return this.pairingStore.consumePairingCode(input);
  }

  listPairingRequests(status?: FeishuPairingRequestRecord['status']) {
    return this.pairingStore.listPairingRequests(status);
  }

  decidePairingRequest(requestId: string, decision: 'approve' | 'reject', now: number) {
    return this.pairingStore.decidePairingRequest(requestId, decision, now);
  }

  prunePairingMetadata(terminalBefore: number, now: number): number {
    return this.pairingStore.prunePairingMetadata(terminalBefore, now);
  }

  pruneDeliveries(terminalBefore: number): number {
    return this.deliveryStore.prune(terminalBefore);
  }

  getHealth(instanceId: string): FeishuConnectionHealth | null {
    const row = this.db.prepare(
      `SELECT * FROM health WHERE instance_id = ?`,
    ).get(instanceId) as Record<string, unknown> | undefined;
    const candidate = row ? {
      instanceId: row.instance_id as string,
      state: row.state as FeishuConnectionHealth['state'],
      generation: row.generation as number,
      reconnectAttempts: row.reconnect_attempts as number,
      lastErrorCode: row.last_error_code as string | null,
      updatedAt: row.updated_at as number,
    } : null;
    return validateFeishuConnectionHealth(candidate, this.binding.instanceId);
  }

  putHealth(value: FeishuConnectionHealth): void {
    const validated = validateFeishuConnectionHealth(value, this.binding.instanceId);
    if (!validated) {
      throw new FeishuGatewayError('invalid_configuration', 'Connection health is required');
    }
    this.db.prepare(`
      INSERT INTO health VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        state = excluded.state,
        generation = excluded.generation,
        reconnect_attempts = excluded.reconnect_attempts,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `).run(
      validated.instanceId, validated.state, validated.generation, validated.reconnectAttempts,
      validated.lastErrorCode, validated.updatedAt,
    );
  }
}
