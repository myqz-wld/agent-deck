import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContextRuntimeIdentity } from '@main/session/context-window/identity';
import { createContextWindowCapacityService } from '@main/session/context-window/service';
import { createContextWindowObservationRepo } from '../context-window-observation-repo';
import {
  bindingAvailable,
  insertSession,
  makeMemoryDb,
} from './agent-deck-repos/_setup';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function identity(provider = 'openai', model = 'gpt-test', config = 'default') {
  return createContextRuntimeIdentity({
    adapter: 'codex-cli',
    runtimeProvider: provider,
    model,
    capacityConfigFingerprint: config,
  });
}

describe.skipIf(!bindingAvailable)('context-window observation repository', () => {
  it('persists observations across connections and keeps rows after session deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-context-window-'));
    temporaryRoots.push(root);
    const dbPath = join(root, 'observations.db');
    const first = makeMemoryDb(dbPath);
    insertSession(first, 'session-a', 'codex-cli');
    const runtime = identity();
    const write = createContextWindowObservationRepo(first).observe({
      identity: runtime,
      windowTokens: 128_000,
      source: 'runtime-usage',
      observedAt: 1_000,
      originSessionId: 'session-a',
    });
    expect(write.applied).toBe(true);
    first.prepare(`DELETE FROM sessions WHERE id = 'session-a'`).run();
    first.close();

    const reopened = new Database(dbPath);
    reopened.pragma('foreign_keys = ON');
    expect(createContextWindowObservationRepo(reopened).get(runtime)).toEqual({
      identity: runtime,
      windowTokens: 128_000,
      source: 'runtime-usage',
      observedAt: 1_000,
      originSessionId: null,
    });
    reopened.close();
  });

  it('replaces by timestamp rather than retaining a process-lifetime minimum', () => {
    const db = makeMemoryDb();
    const repo = createContextWindowObservationRepo(db);
    const runtime = identity();
    repo.observe({
      identity: runtime,
      windowTokens: 64_000,
      source: 'runtime-usage',
      observedAt: 1_000,
    });
    const newer = repo.observe({
      identity: runtime,
      windowTokens: 256_000,
      source: 'runtime-metadata',
      observedAt: 2_000,
    });
    expect(newer).toMatchObject({
      applied: true,
      observation: { windowTokens: 256_000, observedAt: 2_000 },
    });
    const older = repo.observe({
      identity: runtime,
      windowTokens: 32_000,
      source: 'runtime-usage',
      observedAt: 1_999,
    });
    expect(older).toMatchObject({
      applied: false,
      observation: { windowTokens: 256_000, observedAt: 2_000 },
    });
    db.close();
  });

  it('uses source priority and conservative capacity for exact-time conflicts', () => {
    const db = makeMemoryDb();
    const repo = createContextWindowObservationRepo(db);
    const runtime = identity();
    repo.observe({
      identity: runtime,
      windowTokens: 128_000,
      source: 'runtime-metadata',
      observedAt: 5_000,
    });
    expect(
      repo.observe({
        identity: runtime,
        windowTokens: 256_000,
        source: 'effective-config',
        observedAt: 5_000,
      }).applied,
    ).toBe(false);
    expect(
      repo.observe({
        identity: runtime,
        windowTokens: 256_000,
        source: 'runtime-usage',
        observedAt: 5_000,
      }),
    ).toMatchObject({ applied: true, observation: { windowTokens: 256_000 } });
    expect(
      repo.observe({
        identity: runtime,
        windowTokens: 64_000,
        source: 'runtime-usage',
        observedAt: 5_000,
      }),
    ).toMatchObject({ applied: true, observation: { windowTokens: 64_000 } });
    expect(
      repo.observe({
        identity: runtime,
        windowTokens: 128_000,
        source: 'runtime-usage',
        observedAt: 5_000,
      }).applied,
    ).toBe(false);
    db.close();
  });

  it('isolates provider, model, and capacity configuration keys', () => {
    const db = makeMemoryDb();
    const repo = createContextWindowObservationRepo(db);
    const runtimes = [
      identity('openai', 'gpt-test', 'default'),
      identity('azure', 'gpt-test', 'default'),
      identity('openai', 'gpt-other', 'default'),
      identity('openai', 'gpt-test', 'override-64k'),
    ];
    runtimes.forEach((runtime, index) => {
      repo.observe({
        identity: runtime,
        windowTokens: 64_000 + index,
        source: 'runtime-usage',
        observedAt: 1_000,
      });
    });
    expect(runtimes.map((runtime) => repo.get(runtime)?.windowTokens)).toEqual([
      64_000,
      64_001,
      64_002,
      64_003,
    ]);
    db.close();
  });

  it('resolves through the durable service with explicit freshness state', () => {
    const db = makeMemoryDb();
    const runtime = identity();
    const service = createContextWindowCapacityService(db, { now: () => 2_000 });
    expect(service.resolve({ status: 'concrete', identity: runtime })).toMatchObject({
      status: 'unknown',
      reason: 'no-observation',
    });
    service.observe({
      identity: runtime,
      windowTokens: 128_000,
      source: 'runtime-usage',
      observedAt: 1_000,
    });
    expect(service.resolve({ status: 'concrete', identity: runtime })).toMatchObject({
      status: 'observed',
      windowTokens: 128_000,
    });
    db.close();
  });
});
