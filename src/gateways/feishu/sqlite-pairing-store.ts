import type Database from 'better-sqlite3';
import { FeishuGatewayError, type FeishuGatewayBinding } from '@gateways/im';
import type {
  FeishuPairingCodeRecord,
  FeishuPairingConsumeResult,
  FeishuPairingDecisionResult,
  FeishuPairingRequestRecord,
  FeishuPairingStore,
} from './types';

const PAIRING_CODE_MIN_INTERVAL_MS = 30_000;

function pairingCode(row: Record<string, unknown>): FeishuPairingCodeRecord {
  return {
    instanceId: row.instance_id as string,
    codeId: row.code_id as string,
    codeHash: row.code_hash as string,
    status: row.status as FeishuPairingCodeRecord['status'],
    expiresAt: row.expires_at as number,
    createdAt: row.created_at as number,
    consumedAt: row.consumed_at as number | null,
    consumedEventId: row.consumed_event_id as string | null,
  };
}

function pairingRequest(row: Record<string, unknown>): FeishuPairingRequestRecord {
  return {
    instanceId: row.instance_id as string,
    requestId: row.request_id as string,
    codeId: row.code_id as string,
    appId: row.app_id as string,
    tenantKey: row.tenant_key as string,
    openId: row.open_id as string,
    chatId: row.chat_id as string,
    displayName: row.display_name as string | null,
    status: row.status as FeishuPairingRequestRecord['status'],
    credentialId: row.credential_id as string | null,
    expiresAt: row.expires_at as number,
    createdAt: row.created_at as number,
    decidedAt: row.decided_at as number | null,
  };
}

export class SqliteFeishuPairingStore implements FeishuPairingStore {
  constructor(
    private readonly db: Database.Database,
    private readonly binding: FeishuGatewayBinding,
  ) {}

  createPairingCode(input: FeishuPairingCodeRecord): FeishuPairingCodeRecord {
    return this.db.transaction(() => {
      if (
        input.instanceId !== this.binding.instanceId || input.status !== 'active' ||
        input.consumedAt !== null || input.consumedEventId !== null ||
        !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt) ||
        input.createdAt < 0 || input.expiresAt <= input.createdAt
      ) {
        throw new FeishuGatewayError('invalid_configuration', 'Pairing code metadata is invalid');
      }
      const latest = this.db.prepare(`
        SELECT MAX(created_at) AS created_at FROM pairing_codes WHERE instance_id = ?
      `).get(this.binding.instanceId) as { created_at: number | null };
      if (
        latest.created_at !== null &&
        (input.createdAt < latest.created_at ||
          input.createdAt - latest.created_at < PAIRING_CODE_MIN_INTERVAL_MS)
      ) {
        throw new FeishuGatewayError(
          'rate_limited',
          'Pairing codes may be issued only once every 30 seconds',
          true,
        );
      }
      this.db.prepare(`
        UPDATE pairing_codes SET status = 'expired'
        WHERE instance_id = ? AND status = 'active'
      `).run(this.binding.instanceId);
      try {
        this.db.prepare(`
          INSERT INTO pairing_codes VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL)
        `).run(
          input.instanceId, input.codeId, input.codeHash, input.expiresAt, input.createdAt,
        );
      } catch {
        throw new FeishuGatewayError('identity_conflict', 'Pairing code identity already exists');
      }
      return this.getCode(input.codeId);
    }).immediate();
  }

  consumePairingCode(
    input: Parameters<FeishuPairingStore['consumePairingCode']>[0],
  ): FeishuPairingConsumeResult {
    return this.db.transaction(() => {
      if (
        input.instanceId !== this.binding.instanceId || input.appId !== this.binding.appId ||
        input.tenantKey !== this.binding.tenantKey
      ) return { state: 'invalid', request: null } as const;
      const codeRow = this.db.prepare(`
        SELECT * FROM pairing_codes WHERE instance_id = ? AND code_hash = ?
      `).get(input.instanceId, input.codeHash) as Record<string, unknown> | undefined;
      if (!codeRow) return { state: 'invalid', request: null } as const;
      const code = pairingCode(codeRow);
      if (code.status === 'consumed') {
        if (code.consumedEventId !== input.eventId) {
          return { state: 'invalid', request: null } as const;
        }
        const existing = this.requestByCode(code.codeId);
        return existing
          ? { state: 'duplicate', request: existing } as const
          : { state: 'already-paired', request: null } as const;
      }
      if (code.status === 'expired' || input.now >= code.expiresAt) {
        this.db.prepare(`
          UPDATE pairing_codes SET status = 'expired'
          WHERE instance_id = ? AND code_id = ?
        `).run(code.instanceId, code.codeId);
        return { state: 'expired', request: null } as const;
      }
      const paired = this.db.prepare(`
        SELECT open_id FROM credentials
        WHERE instance_id = ? AND status = 'active' AND open_id IS NOT NULL LIMIT 1
      `).get(this.binding.instanceId) as { open_id: string } | undefined;
      this.db.prepare(`
        UPDATE pairing_codes
        SET status = 'consumed', consumed_at = ?, consumed_event_id = ?
        WHERE instance_id = ? AND code_id = ? AND status = 'active'
      `).run(input.now, input.eventId, code.instanceId, code.codeId);
      if (paired) return { state: 'already-paired', request: null } as const;
      try {
        this.db.prepare(`
          INSERT INTO pairing_requests VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL
          )
        `).run(
          input.instanceId, input.requestId, code.codeId, input.appId, input.tenantKey,
          input.openId, input.chatId, input.displayName, code.expiresAt, input.now,
        );
      } catch {
        throw new FeishuGatewayError('identity_conflict', 'Pairing request identity already exists');
      }
      return {
        state: 'accepted',
        request: this.getRequest(input.requestId),
      } as const;
    }).immediate();
  }

  listPairingRequests(
    status?: FeishuPairingRequestRecord['status'],
  ): readonly FeishuPairingRequestRecord[] {
    const rows = status === undefined
      ? this.db.prepare(`
          SELECT * FROM pairing_requests WHERE instance_id = ?
          ORDER BY created_at DESC, request_id
        `).all(this.binding.instanceId)
      : this.db.prepare(`
          SELECT * FROM pairing_requests WHERE instance_id = ? AND status = ?
          ORDER BY created_at DESC, request_id
        `).all(this.binding.instanceId, status);
    return (rows as Record<string, unknown>[]).map(pairingRequest);
  }

  decidePairingRequest(
    requestId: string,
    decision: 'approve' | 'reject',
    now: number,
  ): FeishuPairingDecisionResult {
    return this.db.transaction(() => {
      let request = this.getRequest(requestId);
      if (!request) return { state: 'not-found', request: null } as const;
      if (request.status !== 'pending') {
        return request.status === 'expired'
          ? { state: 'expired', request } as const
          : { state: 'already-decided', request } as const;
      }
      if (now >= request.expiresAt) {
        this.db.prepare(`
          UPDATE pairing_requests SET status = 'expired', decided_at = ?
          WHERE instance_id = ? AND request_id = ? AND status = 'pending'
        `).run(now, this.binding.instanceId, requestId);
        return { state: 'expired', request: this.getRequest(requestId) } as const;
      }
      if (decision === 'reject') {
        this.db.prepare(`
          UPDATE pairing_requests SET status = 'rejected', decided_at = ?
          WHERE instance_id = ? AND request_id = ? AND status = 'pending'
        `).run(now, this.binding.instanceId, requestId);
        return { state: 'rejected', request: this.getRequest(requestId) } as const;
      }
      const credentials = this.db.prepare(`
        SELECT * FROM credentials WHERE instance_id = ? AND status = 'active'
      `).all(this.binding.instanceId) as Record<string, unknown>[];
      if (credentials.length !== 1) {
        throw new FeishuGatewayError(
          'invalid_configuration',
          'Pairing requires exactly one active Feishu connection credential',
        );
      }
      const credential = credentials[0];
      if (credential.open_id !== null && credential.open_id !== request.openId) {
        throw new FeishuGatewayError('identity_conflict', 'Feishu credential is already paired');
      }
      const identity = this.db.prepare(`
        SELECT credential_id FROM credentials
        WHERE app_id = ? AND tenant_key = ? AND open_id = ?
          AND NOT (instance_id = ? AND credential_id = ?)
        LIMIT 1
      `).get(
        request.appId, request.tenantKey, request.openId,
        this.binding.instanceId, credential.credential_id,
      );
      if (identity) {
        throw new FeishuGatewayError('identity_conflict', 'Feishu identity is already paired');
      }
      this.db.prepare(`
        UPDATE credentials SET open_id = ?
        WHERE instance_id = ? AND credential_id = ? AND status = 'active'
      `).run(request.openId, this.binding.instanceId, credential.credential_id);
      this.db.prepare(`
        UPDATE pairing_requests
        SET status = 'approved', credential_id = ?, decided_at = ?
        WHERE instance_id = ? AND request_id = ? AND status = 'pending'
      `).run(credential.credential_id, now, this.binding.instanceId, requestId);
      request = this.getRequest(requestId) as FeishuPairingRequestRecord;
      return { state: 'approved', request } as const;
    }).immediate();
  }

  prunePairingMetadata(terminalBefore: number, now: number): number {
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE pairing_codes SET status = 'expired'
        WHERE instance_id = ? AND status = 'active' AND expires_at <= ?
      `).run(this.binding.instanceId, now);
      this.db.prepare(`
        UPDATE pairing_requests SET status = 'expired', decided_at = ?
        WHERE instance_id = ? AND status = 'pending' AND expires_at <= ?
      `).run(now, this.binding.instanceId, now);
      const requests = this.db.prepare(`
        DELETE FROM pairing_requests
        WHERE instance_id = ? AND status != 'pending' AND decided_at < ?
      `).run(this.binding.instanceId, terminalBefore).changes;
      const codes = this.db.prepare(`
        DELETE FROM pairing_codes
        WHERE instance_id = ? AND status != 'active'
          AND COALESCE(consumed_at, created_at) < ?
          AND NOT EXISTS (
            SELECT 1 FROM pairing_requests
            WHERE pairing_requests.instance_id = pairing_codes.instance_id
              AND pairing_requests.code_id = pairing_codes.code_id
          )
      `).run(this.binding.instanceId, terminalBefore).changes;
      return requests + codes;
    }).immediate();
  }

  private getCode(codeId: string): FeishuPairingCodeRecord {
    const row = this.db.prepare(`
      SELECT * FROM pairing_codes WHERE instance_id = ? AND code_id = ?
    `).get(this.binding.instanceId, codeId) as Record<string, unknown> | undefined;
    if (!row) throw new FeishuGatewayError('invalid_configuration', 'Pairing code disappeared');
    return pairingCode(row);
  }

  private getRequest(requestId: string): FeishuPairingRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pairing_requests WHERE instance_id = ? AND request_id = ?
    `).get(this.binding.instanceId, requestId) as Record<string, unknown> | undefined;
    return row ? pairingRequest(row) : null;
  }

  private requestByCode(codeId: string): FeishuPairingRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pairing_requests WHERE instance_id = ? AND code_id = ?
    `).get(this.binding.instanceId, codeId) as Record<string, unknown> | undefined;
    return row ? pairingRequest(row) : null;
  }
}
