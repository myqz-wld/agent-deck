import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonInstancePaths } from '@hosts/daemon';
import {
  ServerCoreRuntimeMetadataStore,
  type ServerCoreMutationIdentity,
} from './runtime-metadata-store';

const roots: string[] = [];
const stores: ServerCoreRuntimeMetadataStore[] = [];

function paths(): DaemonInstancePaths {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-core-metadata-'));
  roots.push(root);
  return {
    instanceId: 'instance-a',
    stateDirectory: join(root, 'state'),
    configurationDirectory: join(root, 'config'),
    logDirectory: join(root, 'state', 'logs'),
    runtimeDirectory: join(root, 'runtime'),
    socketPath: join(root, 'runtime', 'agent-deckd.sock'),
  };
}

function store(instancePaths = paths()): ServerCoreRuntimeMetadataStore {
  const value = new ServerCoreRuntimeMetadataStore(instancePaths);
  stores.push(value);
  value.start();
  return value;
}

function identity(overrides: Partial<ServerCoreMutationIdentity> = {}): ServerCoreMutationIdentity {
  return {
    connectionScope: 'credential-a',
    accessSurface: 'desktop',
    idempotencyKey: 'mutation-a',
    method: 'session.send',
    requestFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function createLegacyStore(instancePaths: DaemonInstancePaths): string {
  mkdirSync(instancePaths.stateDirectory, { recursive: true });
  const path = join(instancePaths.stateDirectory, 'server-core-runtime.db');
  const database = new Database(path);
  database.exec(`
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
PRAGMA user_version = 1;
  `);
  const now = Date.now();
  database.prepare(`
    INSERT INTO mutation_ledger(
      access_credential_id, access_surface, idempotency_key, method,
      request_fingerprint, status, result_json, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, 4, ?)
  `).run(
    'credential-a', 'desktop-full', 'mutation-a', 'session.send',
    'a'.repeat(64), JSON.stringify({ accepted: true }), now,
  );
  database.prepare(`
    INSERT INTO session_subscriptions(
      access_credential_id, access_surface, session_id, subscribed, updated_at
    ) VALUES (?, ?, ?, 1, ?)
  `).run('credential-a', 'feishu-session-console', 'session-a', now);
  database.close();
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreRuntimeMetadataStore', () => {
  it('creates a private exact-schema store and preserves revision across restart', () => {
    const instancePaths = paths();
    const first = store(instancePaths);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(first.currentRevision()).toBe(0);
    expect(first.appendChange('session.updated', 'session-a', { state: 'active' })).toBe(1);
    first.close();

    const second = store(instancePaths);
    expect(second.currentRevision()).toBe(1);
    expect(second.replay(0)).toEqual([{
      revision: 1,
      kind: 'session.updated',
      entityId: 'session-a',
      payload: { state: 'active' },
    }]);
  });

  it('rejects retired metadata schemas without mutating them', () => {
    const instancePaths = paths();
    const path = createLegacyStore(instancePaths);
    expect(() => store(instancePaths)).toThrow('schema is incompatible');

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(1);
    expect(database.prepare(`PRAGMA table_info(mutation_ledger)`).all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'access_credential_id' })]),
    );
    database.close();
  });

  it('publishes committed changes and makes unsubscribe exact', () => {
    const metadata = store();
    const listener = vi.fn();
    const unsubscribe = metadata.subscribe(listener);
    metadata.appendChange('event.persisted', 'session-a', { eventId: 7 });
    unsubscribe();
    metadata.appendChange('session.removed', 'session-a', null);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      revision: 1,
      kind: 'event.persisted',
      entityId: 'session-a',
      payload: { eventId: 7 },
    });
  });

  it('returns an exact completed mutation for a same-fingerprint retry', () => {
    const metadata = store();
    const input = identity();
    expect(metadata.claimMutation(input, 10)).toEqual({ state: 'claimed' });
    metadata.completeMutation(input, { accepted: true }, 4, 11);

    expect(metadata.claimMutation(input, 12)).toEqual({
      state: 'completed',
      result: { accepted: true },
      revision: 4,
    });
  });

  it('checks expected revision only before the first claim and still replays completion', () => {
    const metadata = store();
    const input = identity();
    metadata.appendChange('existing', null, null);
    expect(metadata.claimMutation(input, 10, 0)).toEqual({ state: 'conflict' });
    expect(metadata.claimMutation(input, 11, 1)).toEqual({ state: 'claimed' });
    metadata.completeMutation(input, { accepted: true, revision: 2 }, 2, 12);
    metadata.appendChange('later', null, null);
    expect(metadata.claimMutation(input, 13, 1)).toEqual({
      state: 'completed',
      result: { accepted: true, revision: 2 },
      revision: 2,
    });
  });

  it('atomically commits a session change with its replay result', () => {
    const metadata = store();
    const input = identity({ method: 'session.console.create' });
    expect(metadata.claimMutation(input, 10)).toEqual({ state: 'claimed' });
    expect(metadata.commitSessionCreate(input, 'session-a', {
      adapterId: 'grok-build', sessionId: 'session-a', workingDirectory: 'repo',
    }, 11)).toEqual({ sessionId: 'session-a', revision: 1 });
    expect(metadata.replay(0)).toEqual([expect.objectContaining({
      kind: 'session.created', entityId: 'session-a', revision: 1,
    })]);
    expect(metadata.claimMutation(input, 12)).toEqual({
      state: 'completed', result: { sessionId: 'session-a', revision: 1 }, revision: 1,
    });
  });

  it('rewrites a completed create replay when its temporary session id becomes canonical', () => {
    const metadata = store();
    const input = identity({ method: 'session.console.create' });
    expect(metadata.claimMutation(input, 10)).toEqual({ state: 'claimed' });
    metadata.commitSessionCreate(input, 'temporary-a', {
      adapterId: 'codex-cli', sessionId: 'temporary-a', workingDirectory: 'repo',
    }, 11);

    metadata.renameSessionMutationResults('temporary-a', 'canonical-a', 12);

    expect(metadata.claimMutation(input, 13)).toEqual({
      state: 'completed',
      result: { sessionId: 'canonical-a', revision: 1 },
      revision: 1,
    });
  });

  it('releases only the exact invoking mutation claim', () => {
    const metadata = store();
    const input = identity();
    expect(metadata.claimMutation(input, 10)).toEqual({ state: 'claimed' });
    metadata.releaseMutationClaim(input);
    expect(metadata.claimMutation(input, 11)).toEqual({ state: 'claimed' });
  });

  it('fails closed for conflicting and crash-ambiguous mutation retries', () => {
    const metadata = store();
    const input = identity();
    expect(metadata.claimMutation(input)).toEqual({ state: 'claimed' });
    expect(metadata.claimMutation(input)).toEqual({ state: 'uncertain' });
    expect(metadata.claimMutation(identity({ method: 'session.steer' }))).toEqual({
      state: 'conflict',
    });
    expect(metadata.claimMutation(identity({ requestFingerprint: 'b'.repeat(64) }))).toEqual({
      state: 'conflict',
    });
  });

  it('persists subscription state by credential and surface', () => {
    const metadata = store();
    metadata.setSubscribed('credential-a', 'desktop', 'session-a', true, 10);
    expect(metadata.isSubscribed('credential-a', 'desktop', 'session-a')).toBe(true);
    expect(metadata.isSubscribed('credential-a', 'feishu', 'session-a')).toBe(false);
    metadata.setSubscribed('credential-a', 'desktop', 'session-a', false, 11);
    expect(metadata.isSubscribed('credential-a', 'desktop', 'session-a')).toBe(false);
  });

  it('rejects oversized change payloads without advancing revision', () => {
    const metadata = store();
    expect(() => metadata.appendChange('large', null, 'x'.repeat(70_000)))
      .toThrow('exceeds its bound');
    expect(metadata.currentRevision()).toBe(0);
  });

  it('rejects an extra schema object on reopen', () => {
    const instancePaths = paths();
    const metadata = store(instancePaths);
    const path = metadata.path;
    metadata.close();
    const database = new Database(path);
    database.exec(`CREATE TABLE injected(value TEXT) STRICT`);
    database.close();

    const reopened = new ServerCoreRuntimeMetadataStore(instancePaths);
    stores.push(reopened);
    expect(() => reopened.start()).toThrow('schema is incompatible');
  });
});
