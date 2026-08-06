import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
    accessCredentialId: 'credential-a',
    accessSurface: 'desktop-full',
    idempotencyKey: 'mutation-a',
    method: 'session.send',
    requestFingerprint: 'a'.repeat(64),
    ...overrides,
  };
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
    metadata.setSubscribed('credential-a', 'desktop-full', 'session-a', true, 10);
    expect(metadata.isSubscribed('credential-a', 'desktop-full', 'session-a')).toBe(true);
    expect(metadata.isSubscribed('credential-a', 'feishu-session-console', 'session-a')).toBe(false);
    metadata.setSubscribed('credential-a', 'desktop-full', 'session-a', false, 11);
    expect(metadata.isSubscribed('credential-a', 'desktop-full', 'session-a')).toBe(false);
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
