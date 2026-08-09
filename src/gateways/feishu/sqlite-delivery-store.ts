import type Database from 'better-sqlite3';
import {
  FeishuGatewayError,
  type DeliveryClaim,
  type FeishuDeliveryRecord,
} from '@gateways/im';

export type SqliteDeliveryInput = Omit<
  FeishuDeliveryRecord,
  'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' |
  'transportIdempotencyExpiresAt' | 'transportSafety'
>;

function safeDeadline(now: number, lifetimeMs: number): number {
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0
  ) {
    throw new FeishuGatewayError('invalid_configuration', 'Delivery attempt lifetime is invalid');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, now + lifetimeMs);
}

function delivery(row: Record<string, unknown>): FeishuDeliveryRecord {
  return {
    instanceId: row.instance_id as string,
    eventId: row.event_id as string,
    credentialId: row.credential_id as string,
    chatId: row.chat_id as string,
    status: row.status as FeishuDeliveryRecord['status'],
    attempts: row.attempts as number,
    phase: row.phase as FeishuDeliveryRecord['phase'],
    transportSafety: row.transport_safety as FeishuDeliveryRecord['transportSafety'],
    transportIdempotencyExpiresAt: row.transport_idempotency_expires_at as number | null,
    attemptDeadlineAt: row.attempt_deadline_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class SqliteFeishuDeliveryStore {
  constructor(private readonly db: Database.Database) {}

  claim(input: SqliteDeliveryInput, maximum: number, lifetimeMs = 30_000): DeliveryClaim {
    return this.db.transaction(() => this.claimLocked(input, maximum, lifetimeMs)).immediate();
  }

  private claimLocked(
    input: SqliteDeliveryInput,
    maximum: number,
    lifetimeMs: number,
  ): DeliveryClaim {
    const existing = this.get(input.instanceId, input.eventId);
    if (!existing) {
      const created: FeishuDeliveryRecord = {
        ...input,
        status: 'pending',
        attempts: 1,
        phase: 'core',
        transportSafety: null,
        transportIdempotencyExpiresAt: null,
        attemptDeadlineAt: safeDeadline(input.updatedAt, lifetimeMs),
      };
      this.write(created);
      return { state: 'claimed', record: created };
    }
    if (existing.credentialId !== input.credentialId || existing.chatId !== input.chatId) {
      throw new FeishuGatewayError('event_identity_mismatch', 'Event replay changed stable identity');
    }
    if (existing.status === 'pending' && input.updatedAt < existing.attemptDeadlineAt) {
      return { state: 'in-progress', record: existing };
    }
    if (
      ['failed', 'pending'].includes(existing.status) &&
      existing.phase === 'transport-invoked' && existing.transportSafety !== 'safe'
    ) {
      const next = { ...existing, status: 'reconciling' as const, updatedAt: input.updatedAt };
      this.write(next);
      return { state: 'reconciliation-required', record: next };
    }
    if (
      ['failed', 'pending'].includes(existing.status) && existing.phase === 'transport-invoked' &&
      existing.transportSafety === 'safe' &&
      (existing.transportIdempotencyExpiresAt === null ||
        input.updatedAt >= existing.transportIdempotencyExpiresAt)
    ) {
      const next = { ...existing, status: 'exhausted' as const, updatedAt: input.updatedAt };
      this.write(next);
      return { state: 'exhausted', record: next };
    }
    if (existing.status === 'reconciling') {
      return { state: 'reconciliation-required', record: existing };
    }
    if (existing.status === 'exhausted') return { state: 'exhausted', record: existing };
    if (existing.status === 'sent' || existing.status === 'deduplicated') {
      const next = { ...existing, status: 'deduplicated' as const };
      this.write(next);
      return { state: 'duplicate', record: next };
    }
    if (
      !Number.isSafeInteger(existing.attempts) || existing.attempts < 1 ||
      existing.attempts >= maximum
    ) {
      const next = { ...existing, status: 'exhausted' as const, updatedAt: input.updatedAt };
      this.write(next);
      return { state: 'exhausted', record: next };
    }
    const next: FeishuDeliveryRecord = {
      ...existing,
      status: 'pending',
      attempts: existing.attempts + 1,
      phase: 'core',
      transportSafety: null,
      transportIdempotencyExpiresAt: null,
      attemptDeadlineAt: safeDeadline(input.updatedAt, lifetimeMs),
      updatedAt: input.updatedAt,
    };
    this.write(next);
    return { state: 'claimed', record: next };
  }

  markPreTransport(instanceId: string, eventId: string, attempt: number, at: number): boolean {
    return this.updatePhase(
      instanceId, eventId, attempt, ['core'], 'pre-transport', null, null, at,
    );
  }

  markTransportInvoked(
    instanceId: string,
    eventId: string,
    attempt: number,
    safety: 'safe' | 'unknown',
    expiresAt: number | null,
    at: number,
  ): boolean {
    if (
      (safety === 'safe' &&
        (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= at)) ||
      (safety === 'unknown' && expiresAt !== null)
    ) return false;
    return this.db.transaction(() => {
      const current = this.get(instanceId, eventId);
      const retainedExpiry =
        safety === 'safe' &&
        current?.status === 'pending' &&
        current.attempts === attempt &&
        current.phase === 'transport-invoked' &&
        current.transportSafety === 'safe' &&
        current.transportIdempotencyExpiresAt !== null
          ? Math.min(current.transportIdempotencyExpiresAt, expiresAt as number)
          : expiresAt;
      const allowed = safety === 'safe'
        ? ['pre-transport', 'transport-invoked']
        : ['pre-transport'];
      return this.updatePhase(
        instanceId,
        eventId,
        attempt,
        allowed,
        'transport-invoked',
        safety,
        retainedExpiry,
        at,
      );
    }).immediate();
  }

  private updatePhase(
    instanceId: string,
    eventId: string,
    attempt: number,
    allowed: readonly string[],
    phase: FeishuDeliveryRecord['phase'],
    safety: FeishuDeliveryRecord['transportSafety'],
    expiresAt: number | null,
    at: number,
  ): boolean {
    const placeholders = allowed.map(() => '?').join(', ');
    return this.db.prepare(`
      UPDATE deliveries SET phase = ?, transport_safety = ?,
        transport_idempotency_expires_at = ?, updated_at = ?
      WHERE instance_id = ? AND event_id = ? AND attempts = ? AND status = 'pending'
        AND phase IN (${placeholders})
    `).run(phase, safety, expiresAt, at, instanceId, eventId, attempt, ...allowed).changes === 1;
  }

  markNotAccepted(instanceId: string, eventId: string, attempt: number, at: number): boolean {
    return this.db.transaction(() => {
      const current = this.get(instanceId, eventId);
      if (
        !current || current.attempts !== attempt || current.phase !== 'transport-invoked' ||
        current.transportSafety === null ||
        (current.status !== 'pending' && current.transportSafety !== 'unknown') ||
        !['exhausted', 'pending', 'reconciling'].includes(current.status)
      ) return false;
      this.write({
        ...current,
        status: current.status === 'pending' ? 'pending' : 'failed',
        phase: 'pre-transport',
        transportSafety: null,
        transportIdempotencyExpiresAt: null,
        updatedAt: at,
      });
      return true;
    }).immediate();
  }

  finish(
    instanceId: string,
    eventId: string,
    attempt: number,
    status: 'failed' | 'reconciling' | 'sent',
    at: number,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE deliveries SET status = ?, updated_at = ?
      WHERE instance_id = ? AND event_id = ? AND attempts = ? AND status = 'pending'
    `).run(status, at, instanceId, eventId, attempt);
    if (result.changes === 0 && !this.get(instanceId, eventId)) {
      throw new FeishuGatewayError('delivery_missing', 'Cannot finish an unclaimed delivery');
    }
    return result.changes === 1;
  }

  get(instanceId: string, eventId: string): FeishuDeliveryRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM deliveries WHERE instance_id = ? AND event_id = ?`,
    ).get(instanceId, eventId) as Record<string, unknown> | undefined;
    return row ? delivery(row) : null;
  }

  requireReconciliation(
    instanceId: string,
    eventId: string,
    attempt: number,
    at: number,
  ): boolean {
    return this.db.prepare(`
      UPDATE deliveries SET status = 'exhausted', updated_at = ?
      WHERE instance_id = ? AND event_id = ? AND attempts = ? AND status = 'reconciling'
    `).run(at, instanceId, eventId, attempt).changes === 1;
  }

  prune(terminalBefore: number): number {
    if (!Number.isSafeInteger(terminalBefore) || terminalBefore < 0) {
      throw new FeishuGatewayError('invalid_configuration', 'Delivery retention cutoff is invalid');
    }
    return this.db.prepare(`
      DELETE FROM deliveries
      WHERE status IN ('deduplicated', 'exhausted', 'failed', 'sent')
        AND updated_at < ?
    `).run(terminalBefore).changes;
  }

  private write(value: FeishuDeliveryRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.instanceId, value.eventId, value.credentialId, value.chatId, value.status,
      value.attempts, value.phase, value.transportSafety, value.attemptDeadlineAt, value.updatedAt,
      value.transportIdempotencyExpiresAt,
    );
  }
}
