import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import {
  isJsonValue,
  type JsonValue,
  type SessionConsoleCreateResult,
} from '@contracts/index';
import type { DaemonInstancePaths } from '@hosts/daemon';

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_REPLAY_EVENTS = 256;
const CHANGE_RETENTION = 10_000;
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const SCHEMA_SQL = `
CREATE TABLE core_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  current_revision INTEGER NOT NULL CHECK(current_revision >= 0)
) STRICT;
CREATE TABLE change_log (
  revision INTEGER PRIMARY KEY CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 128),
  entity_id TEXT CHECK(entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE mutation_ledger (
  access_credential_id TEXT NOT NULL CHECK(length(access_credential_id) BETWEEN 1 AND 256),
  access_surface TEXT NOT NULL CHECK(access_surface IN ('desktop-full', 'feishu-session-console')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
  status TEXT NOT NULL CHECK(status IN ('invoking', 'completed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  revision INTEGER CHECK(revision IS NULL OR revision >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(access_credential_id, access_surface, idempotency_key)
) STRICT;
CREATE TABLE session_subscriptions (
  access_credential_id TEXT NOT NULL CHECK(length(access_credential_id) BETWEEN 1 AND 256),
  access_surface TEXT NOT NULL CHECK(access_surface IN ('desktop-full', 'feishu-session-console')),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  subscribed INTEGER NOT NULL CHECK(subscribed IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(access_credential_id, access_surface, session_id)
) STRICT;
INSERT INTO core_state(singleton, current_revision) VALUES (1, 0);
`;

export interface ServerCoreChangeRecord {
  readonly revision: number;
  readonly kind: string;
  readonly entityId: string | null;
  readonly payload: JsonValue;
}

export type ServerCoreMutationClaim =
  | { readonly state: 'claimed' }
  | { readonly state: 'completed'; readonly result: JsonValue; readonly revision: number }
  | { readonly state: 'conflict' }
  | { readonly state: 'uncertain' };

export interface ServerCoreMutationIdentity {
  readonly accessCredentialId: string;
  readonly accessSurface: 'desktop-full' | 'feishu-session-console';
  readonly idempotencyKey: string;
  readonly method: string;
  readonly requestFingerprint: string;
}

interface SchemaRow {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

function schemaFingerprint(database: Database.Database): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function expectedFingerprint(): string {
  const database = new Database(':memory:');
  try {
    database.exec(SCHEMA_SQL);
    return schemaFingerprint(database);
  } finally {
    database.close();
  }
}

const EXPECTED_FINGERPRINT = expectedFingerprint();

function json(value: JsonValue): string {
  if (!isJsonValue(value)) throw new Error('Core metadata payload must be JSON');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new Error('Core metadata payload exceeds its bound');
  }
  return encoded;
}

function token(value: string, field: string, maxBytes = 512): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > maxBytes || CONTROL.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function metadataPath(paths: DaemonInstancePaths): string {
  const value = join(paths.stateDirectory, 'server-core-runtime.db');
  if (!isAbsolute(value) || normalize(value) !== value || CONTROL.test(value)) {
    throw new Error('Core metadata path is invalid');
  }
  return value;
}

function parseJson(raw: string): JsonValue {
  const value = JSON.parse(raw) as unknown;
  if (!isJsonValue(value)) throw new Error('Core metadata row is not JSON');
  return value;
}

/** Strict metadata-only store for global revisions, replay, idempotency, and subscriptions. */
export class ServerCoreRuntimeMetadataStore {
  readonly path: string;
  private database: Database.Database | null = null;
  private readonly listeners = new Set<(change: ServerCoreChangeRecord) => void>();

  constructor(paths: DaemonInstancePaths) {
    this.path = metadataPath(paths);
  }

  start(): void {
    if (this.database) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const fresh = !existsSync(this.path);
    if (!fresh) {
      const entry = lstatSync(this.path);
      if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
        throw new Error('Core metadata file ownership boundary is invalid');
      }
    }
    const database = new Database(this.path);
    let published = false;
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('trusted_schema = ON');
      if (fresh) {
        database.transaction(() => {
          database.exec(SCHEMA_SQL);
          database.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
        chmodSync(this.path, 0o600);
      }
      const version = database.pragma('user_version', { simple: true }) as number;
      if (version !== SCHEMA_VERSION || schemaFingerprint(database) !== EXPECTED_FINGERPRINT) {
        throw new Error('Core metadata schema is incompatible');
      }
      this.database = database;
      published = true;
      this.prune(Date.now());
    } finally {
      if (!published) database.close();
    }
  }

  close(): void {
    this.listeners.clear();
    const database = this.database;
    this.database = null;
    database?.close();
  }

  currentRevision(): number {
    return Number(this.db().prepare(
      `SELECT current_revision FROM core_state WHERE singleton = 1`,
    ).pluck().get());
  }

  appendChange(kind: string, entityId: string | null, payload: JsonValue): number {
    token(kind, 'change kind', 128);
    if (entityId !== null) token(entityId, 'change entity', 256);
    const payloadJson = json(payload);
    const createdAt = Date.now();
    const revision = this.db().transaction(() => {
      const next = this.currentRevision() + 1;
      this.db().prepare(
        `UPDATE core_state SET current_revision = ? WHERE singleton = 1`,
      ).run(next);
      this.db().prepare(
        `INSERT INTO change_log(revision, kind, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(next, kind, entityId, payloadJson, createdAt);
      this.db().prepare(`DELETE FROM change_log WHERE revision <= ?`).run(
        Math.max(0, next - CHANGE_RETENTION),
      );
      return next;
    })();
    const change = Object.freeze({ revision, kind, entityId, payload });
    for (const listener of [...this.listeners]) {
      try { listener(change); } catch {}
    }
    return revision;
  }

  replay(afterRevision: number): ServerCoreChangeRecord[] {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error('Replay revision is invalid');
    }
    const first = this.db().prepare(`SELECT MIN(revision) FROM change_log`).pluck().get() as
      | number
      | null;
    if (first !== null && afterRevision < first - 1) {
      throw new Error('Core replay gap');
    }
    const rows = this.db().prepare(
      `SELECT revision, kind, entity_id AS entityId, payload_json AS payloadJson
         FROM change_log WHERE revision > ? ORDER BY revision ASC LIMIT ?`,
    ).all(afterRevision, MAX_REPLAY_EVENTS + 1) as Array<{
      revision: number;
      kind: string;
      entityId: string | null;
      payloadJson: string;
    }>;
    if (rows.length > MAX_REPLAY_EVENTS) throw new Error('Core replay exceeds its bound');
    return rows.map((row) => Object.freeze({
      revision: row.revision,
      kind: row.kind,
      entityId: row.entityId,
      payload: parseJson(row.payloadJson),
    }));
  }

  subscribe(listener: (change: ServerCoreChangeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimMutation(
    identity: ServerCoreMutationIdentity,
    now = Date.now(),
    expectedRevision?: number,
  ): ServerCoreMutationClaim {
    this.validateMutationIdentity(identity);
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new Error('Expected mutation revision is invalid');
    }
    return this.db().transaction(() => {
      const row = this.db().prepare(
        `SELECT method, request_fingerprint AS fingerprint, status, result_json AS resultJson,
                revision
           FROM mutation_ledger
          WHERE access_credential_id = ? AND access_surface = ? AND idempotency_key = ?`,
      ).get(
        identity.accessCredentialId,
        identity.accessSurface,
        identity.idempotencyKey,
      ) as {
        method: string;
        fingerprint: string;
        status: 'invoking' | 'completed';
        resultJson: string | null;
        revision: number | null;
      } | undefined;
      if (row) {
        if (row.method !== identity.method || row.fingerprint !== identity.requestFingerprint) {
          return { state: 'conflict' } as const;
        }
        if (row.status === 'invoking') return { state: 'uncertain' } as const;
        if (row.resultJson === null || row.revision === null) {
          throw new Error('Completed Core mutation metadata is incomplete');
        }
        return {
          state: 'completed',
          result: parseJson(row.resultJson),
          revision: row.revision,
        } as const;
      }
      if (expectedRevision !== undefined && this.currentRevision() !== expectedRevision) {
        return { state: 'conflict' } as const;
      }
      this.db().prepare(
        `INSERT INTO mutation_ledger(
           access_credential_id, access_surface, idempotency_key, method,
           request_fingerprint, status, result_json, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'invoking', NULL, NULL, ?)`,
      ).run(
        identity.accessCredentialId,
        identity.accessSurface,
        identity.idempotencyKey,
        identity.method,
        identity.requestFingerprint,
        now,
      );
      return { state: 'claimed' } as const;
    })();
  }

  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
    now = Date.now(),
  ): void {
    this.validateMutationIdentity(identity);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Mutation revision is invalid');
    }
    const changed = this.db().prepare(
      `UPDATE mutation_ledger
          SET status = 'completed', result_json = ?, revision = ?, updated_at = ?
        WHERE access_credential_id = ? AND access_surface = ? AND idempotency_key = ?
          AND method = ? AND request_fingerprint = ? AND status = 'invoking'`,
    ).run(
      json(result),
      revision,
      now,
      identity.accessCredentialId,
      identity.accessSurface,
      identity.idempotencyKey,
      identity.method,
      identity.requestFingerprint,
    );
    if (changed.changes !== 1) throw new Error('Mutation claim was lost before completion');
  }

  commitSessionCreate(
    identity: ServerCoreMutationIdentity,
    sessionId: string,
    payload: JsonValue,
    now = Date.now(),
  ): SessionConsoleCreateResult {
    this.validateMutationIdentity(identity);
    if (identity.method !== 'session.console.create') {
      throw new Error('Session create mutation identity is invalid');
    }
    token(sessionId, 'session', 256);
    const payloadJson = json(payload);
    const result = this.db().transaction(() => {
      const revision = this.currentRevision() + 1;
      const value = { sessionId, revision };
      this.db().prepare(
        `UPDATE core_state SET current_revision = ? WHERE singleton = 1`,
      ).run(revision);
      this.db().prepare(
        `INSERT INTO change_log(revision, kind, entity_id, payload_json, created_at)
         VALUES (?, 'session.created', ?, ?, ?)`,
      ).run(revision, sessionId, payloadJson, now);
      const changed = this.db().prepare(
        `UPDATE mutation_ledger
            SET status = 'completed', result_json = ?, revision = ?, updated_at = ?
          WHERE access_credential_id = ? AND access_surface = ? AND idempotency_key = ?
            AND method = ? AND request_fingerprint = ? AND status = 'invoking'`,
      ).run(
        json(value), revision, now, identity.accessCredentialId, identity.accessSurface,
        identity.idempotencyKey, identity.method, identity.requestFingerprint,
      );
      if (changed.changes !== 1) throw new Error('Session create mutation claim was lost');
      this.db().prepare(`DELETE FROM change_log WHERE revision <= ?`).run(
        Math.max(0, revision - CHANGE_RETENTION),
      );
      return value;
    })();
    const change = Object.freeze({
      revision: result.revision,
      kind: 'session.created',
      entityId: sessionId,
      payload,
    });
    for (const listener of [...this.listeners]) {
      try { listener(change); } catch {}
    }
    return result;
  }

  renameSessionMutationResults(fromId: string, toId: string, now = Date.now()): void {
    token(fromId, 'renamed session source', 256);
    token(toId, 'renamed session target', 256);
    if (fromId === toId) return;
    this.db().prepare(
      `UPDATE mutation_ledger
          SET result_json = json_set(result_json, '$.sessionId', ?), updated_at = ?
        WHERE status = 'completed'
          AND json_extract(result_json, '$.sessionId') = ?`,
    ).run(toId, now, fromId);
  }

  releaseMutationClaim(identity: ServerCoreMutationIdentity): void {
    this.validateMutationIdentity(identity);
    const changed = this.db().prepare(
      `DELETE FROM mutation_ledger
        WHERE access_credential_id = ? AND access_surface = ? AND idempotency_key = ?
          AND method = ? AND request_fingerprint = ? AND status = 'invoking'`,
    ).run(
      identity.accessCredentialId,
      identity.accessSurface,
      identity.idempotencyKey,
      identity.method,
      identity.requestFingerprint,
    );
    if (changed.changes !== 1) throw new Error('Mutation claim was lost before release');
  }

  setSubscribed(
    accessCredentialId: string,
    accessSurface: 'desktop-full' | 'feishu-session-console',
    sessionId: string,
    subscribed: boolean,
    now = Date.now(),
  ): void {
    token(accessCredentialId, 'credential', 256);
    token(sessionId, 'session', 256);
    this.db().prepare(
      `INSERT INTO session_subscriptions(
         access_credential_id, access_surface, session_id, subscribed, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(access_credential_id, access_surface, session_id) DO UPDATE SET
         subscribed = excluded.subscribed, updated_at = excluded.updated_at`,
    ).run(accessCredentialId, accessSurface, sessionId, subscribed ? 1 : 0, now);
  }

  isSubscribed(
    accessCredentialId: string,
    accessSurface: 'desktop-full' | 'feishu-session-console',
    sessionId: string,
  ): boolean {
    return this.db().prepare(
      `SELECT subscribed FROM session_subscriptions
        WHERE access_credential_id = ? AND access_surface = ? AND session_id = ?`,
    ).pluck().get(accessCredentialId, accessSurface, sessionId) === 1;
  }

  private prune(now: number): void {
    this.db().prepare(
      `DELETE FROM mutation_ledger WHERE status = 'completed' AND updated_at < ?`,
    ).run(Math.max(0, now - IDEMPOTENCY_RETENTION_MS));
  }

  private validateMutationIdentity(identity: ServerCoreMutationIdentity): void {
    token(identity.accessCredentialId, 'mutation credential', 256);
    token(identity.idempotencyKey, 'mutation idempotency key');
    token(identity.method, 'mutation method', 128);
    if (!/^[0-9a-f]{64}$/.test(identity.requestFingerprint)) {
      throw new Error('Mutation fingerprint is invalid');
    }
  }

  private db(): Database.Database {
    if (!this.database) throw new Error('Core metadata store is not started');
    return this.database;
  }
}
