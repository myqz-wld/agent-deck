import type Database from 'better-sqlite3';
import {
  FeishuGatewayError,
  type FeishuSessionDeleteClaim,
  type FeishuSessionDeleteConfirmation,
} from '@gateways/im';

function record(row: Record<string, unknown>): FeishuSessionDeleteConfirmation {
  return {
    instanceId: row.instance_id as string,
    confirmationId: row.confirmation_id as string,
    tokenHash: row.token_hash as string,
    credentialId: row.credential_id as string,
    chatId: row.chat_id as string,
    openId: row.open_id as string,
    sessionId: row.session_id as string,
    expectedArchived: row.expected_archived === 1,
    expectedUpdatedAt: row.expected_updated_at as number,
    status: row.status as FeishuSessionDeleteConfirmation['status'],
    claimEventId: row.claim_event_id as string | null,
    claimExpiresAt: row.claim_expires_at as number | null,
    expiresAt: row.expires_at as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function safeDeadline(now: number, lifetimeMs: number): number {
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Delete confirmation claim lifetime is invalid',
    );
  }
  return Math.min(Number.MAX_SAFE_INTEGER, now + lifetimeMs);
}

export class SqliteFeishuDeleteConfirmationStore {
  constructor(private readonly db: Database.Database) {}

  create(input: FeishuSessionDeleteConfirmation): FeishuSessionDeleteConfirmation {
    return this.db.transaction(() => {
      const credential = this.db.prepare(`
        SELECT open_id, status FROM credentials
        WHERE instance_id = ? AND credential_id = ?
      `).get(input.instanceId, input.credentialId) as
        { open_id: string | null; status: string } | undefined;
      if (credential?.status !== 'active' || credential.open_id !== input.openId) {
        throw new FeishuGatewayError('revoked', 'Feishu credential is not actively paired');
      }
      const current = this.db.prepare(`
        SELECT * FROM delete_confirmations
        WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
          AND status IN ('pending', 'executing')
        ORDER BY created_at DESC LIMIT 1
      `).get(input.instanceId, input.credentialId, input.chatId) as
        Record<string, unknown> | undefined;
      if (
        current?.status === 'executing' &&
        typeof current.claim_expires_at === 'number' &&
        current.claim_expires_at > input.createdAt
      ) {
        throw new FeishuGatewayError(
          'event_in_progress',
          'A session deletion confirmation is already executing',
          true,
        );
      }
      this.db.prepare(`
        UPDATE delete_confirmations
        SET status = 'expired', claim_event_id = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
          AND status IN ('pending', 'executing')
      `).run(input.createdAt, input.instanceId, input.credentialId, input.chatId);
      try {
        this.db.prepare(`
          INSERT INTO delete_confirmations VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?
          )
        `).run(
          input.instanceId, input.confirmationId, input.tokenHash, input.credentialId,
          input.chatId, input.openId, input.sessionId, input.expectedArchived ? 1 : 0,
          input.expectedUpdatedAt, input.expiresAt, input.createdAt, input.updatedAt,
        );
      } catch {
        throw new FeishuGatewayError(
          'identity_conflict',
          'Delete confirmation identity already exists',
        );
      }
      return this.getRequired(input.instanceId, input.confirmationId);
    }).immediate();
  }

  claim(input: {
    instanceId: string;
    credentialId: string;
    chatId: string;
    openId: string;
    tokenHash: string;
    eventId: string;
    now: number;
    claimLifetimeMs: number;
  }): FeishuSessionDeleteClaim {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM delete_confirmations WHERE instance_id = ? AND token_hash = ?
      `).get(input.instanceId, input.tokenHash) as Record<string, unknown> | undefined;
      if (!row) return { state: 'invalid', record: null } as const;
      let current = record(row);
      if (
        current.credentialId !== input.credentialId || current.chatId !== input.chatId ||
        current.openId !== input.openId
      ) return { state: 'invalid', record: null } as const;
      if (current.status === 'completed') return { state: 'completed', record: current } as const;
      if (current.status === 'expired' || input.now >= current.expiresAt) {
        this.db.prepare(`
          UPDATE delete_confirmations
          SET status = 'expired', claim_event_id = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE instance_id = ? AND confirmation_id = ?
        `).run(input.now, current.instanceId, current.confirmationId);
        current = this.getRequired(current.instanceId, current.confirmationId);
        return { state: 'expired', record: current } as const;
      }
      if (
        current.status === 'executing' && current.claimEventId !== input.eventId &&
        current.claimExpiresAt !== null && input.now < current.claimExpiresAt
      ) return { state: 'in-progress', record: current } as const;
      this.db.prepare(`
        UPDATE delete_confirmations
        SET status = 'executing', claim_event_id = ?, claim_expires_at = ?, updated_at = ?
        WHERE instance_id = ? AND confirmation_id = ?
      `).run(
        input.eventId, safeDeadline(input.now, input.claimLifetimeMs), input.now,
        current.instanceId, current.confirmationId,
      );
      current = this.getRequired(current.instanceId, current.confirmationId);
      return { state: 'claimed', record: current } as const;
    }).immediate();
  }

  release(instanceId: string, confirmationId: string, eventId: string, updatedAt: number): boolean {
    return this.db.prepare(`
      UPDATE delete_confirmations
      SET status = 'pending', claim_event_id = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE instance_id = ? AND confirmation_id = ?
        AND status = 'executing' AND claim_event_id = ?
    `).run(updatedAt, instanceId, confirmationId, eventId).changes === 1;
  }

  complete(instanceId: string, confirmationId: string, eventId: string, updatedAt: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE delete_confirmations
        SET status = 'completed', claim_expires_at = NULL, updated_at = ?
        WHERE instance_id = ? AND confirmation_id = ?
          AND status = 'executing' AND claim_event_id = ?
      `).run(updatedAt, instanceId, confirmationId, eventId).changes;
      if (changed !== 1) return false;
      const current = this.getRequired(instanceId, confirmationId);
      this.db.prepare(`
        UPDATE contexts SET active_session_id = NULL, updated_at = ?
        WHERE instance_id = ? AND credential_id = ? AND chat_id = ?
          AND active_session_id = ?
      `).run(
        updatedAt, current.instanceId, current.credentialId, current.chatId, current.sessionId,
      );
      this.db.prepare(`
        DELETE FROM subscriptions
        WHERE instance_id = ? AND credential_id = ? AND chat_id = ? AND session_id = ?
      `).run(current.instanceId, current.credentialId, current.chatId, current.sessionId);
      return true;
    }).immediate();
  }

  get(instanceId: string, confirmationId: string): FeishuSessionDeleteConfirmation | null {
    const row = this.db.prepare(`
      SELECT * FROM delete_confirmations WHERE instance_id = ? AND confirmation_id = ?
    `).get(instanceId, confirmationId) as Record<string, unknown> | undefined;
    return row ? record(row) : null;
  }

  prune(terminalBefore: number, now: number): number {
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE delete_confirmations
        SET status = 'expired', claim_event_id = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE status IN ('pending', 'executing') AND expires_at <= ?
      `).run(now, now);
      return this.db.prepare(`
        DELETE FROM delete_confirmations
        WHERE status IN ('completed', 'expired') AND updated_at < ?
      `).run(terminalBefore).changes;
    }).immediate();
  }

  private getRequired(instanceId: string, confirmationId: string): FeishuSessionDeleteConfirmation {
    const value = this.get(instanceId, confirmationId);
    if (!value) {
      throw new FeishuGatewayError('invalid_configuration', 'Delete confirmation disappeared');
    }
    return value;
  }
}
