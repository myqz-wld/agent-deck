import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextRuntimeIdentity } from '@main/session/context-window/identity';
import { createContextWindowObservationRepo } from '../../context-window-observation-repo';
import { bindingAvailable, makeMemoryDb } from './_setup';

let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('[context-usage.test] database is not initialized');
    return currentDb;
  },
}));

import { sessionRepo } from '../index';
import { renameWithDb } from '../rename';

function insertSession(id = 'session-a'): void {
  currentDb!.prepare(
    `INSERT INTO sessions
       (id, agent_id, runtime_provider, model, cwd, title, source, lifecycle, activity,
        started_at, last_event_at)
     VALUES (?, 'codex-cli', 'openai', 'gpt-a', '/repo', ?, 'sdk', 'active', 'idle', 1, 1)`,
  ).run(id, `title-${id}`);
}

function runtime(provider = 'openai', model = 'gpt-a') {
  return createContextRuntimeIdentity({
    adapter: 'codex-cli',
    runtimeProvider: provider,
    model,
  });
}

describe.skipIf(!bindingAvailable)('runtime-bound session context usage', () => {
  beforeEach(() => {
    currentDb = makeMemoryDb();
    insertSession();
  });

  afterEach(() => {
    currentDb?.close();
    currentDb = null;
  });

  it('preserves partial fields only within the same runtime identity', () => {
    const firstIdentity = runtime();
    expect(
      sessionRepo.updateContextUsage(
        'session-a',
        { usedTokens: 10_000, windowTokens: 128_000, runtimeIdentity: firstIdentity },
        100,
      ),
    ).toEqual({
      usedTokens: 10_000,
      windowTokens: 128_000,
      updatedAt: 100,
      runtimeIdentity: firstIdentity,
    });
    expect(
      sessionRepo.updateContextUsage(
        'session-a',
        { usedTokens: 20_000, runtimeIdentity: firstIdentity },
        200,
      ),
    ).toMatchObject({ usedTokens: 20_000, windowTokens: 128_000 });

    const secondIdentity = runtime('azure', 'gpt-b');
    expect(
      sessionRepo.updateContextUsage(
        'session-a',
        { usedTokens: 500, runtimeIdentity: secondIdentity },
        300,
      ),
    ).toEqual({
      usedTokens: 500,
      windowTokens: null,
      updatedAt: 300,
      runtimeIdentity: secondIdentity,
    });
  });

  it('preserves identity/window for compaction updates and ignores older events', () => {
    const identity = runtime();
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 10_000, windowTokens: 128_000, runtimeIdentity: identity },
      200,
    );
    expect(
      sessionRepo.updateContextUsage('session-a', { usedTokens: null }, 300),
    ).toEqual({
      usedTokens: null,
      windowTokens: 128_000,
      updatedAt: 300,
      runtimeIdentity: identity,
    });
    expect(
      sessionRepo.updateContextUsage(
        'session-a',
        { usedTokens: 99_000, runtimeIdentity: runtime('stale', 'stale') },
        250,
      ),
    ).toEqual({
      usedTokens: null,
      windowTokens: 128_000,
      updatedAt: 300,
      runtimeIdentity: identity,
    });
  });

  it('does not persist an observation from an out-of-order snapshot event', () => {
    const currentIdentity = runtime();
    const staleIdentity = runtime('stale-provider', 'stale-model');
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 10_000, windowTokens: 128_000, runtimeIdentity: currentIdentity },
      300,
    );

    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 5_000, windowTokens: 64_000, runtimeIdentity: staleIdentity },
      250,
      {
        identity: staleIdentity,
        windowTokens: 64_000,
        source: 'runtime-usage',
        observedAt: 250,
        originSessionId: 'session-a',
      },
    );

    expect(sessionRepo.get('session-a')?.contextUsage?.runtimeIdentity).toEqual(currentIdentity);
    expect(createContextWindowObservationRepo(currentDb!).get(staleIdentity)).toBeNull();
  });

  it('normalizes unsafe token counts without throwing into the ingest path', () => {
    const identity = runtime();
    expect(
      sessionRepo.updateContextUsage(
        'session-a',
        { usedTokens: 1e20, windowTokens: 1e20, runtimeIdentity: identity },
        400,
      ),
    ).toMatchObject({ usedTokens: null, windowTokens: null });
  });

  it('atomically stores a session snapshot and durable capacity observation', () => {
    const identity = runtime();
    const usage = sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 1_000, windowTokens: 128_000, runtimeIdentity: identity },
      400,
      {
        identity,
        windowTokens: 128_000,
        source: 'runtime-usage',
        observedAt: 400,
        originSessionId: 'session-a',
      },
    );
    expect(usage).toMatchObject({ runtimeIdentity: identity, windowTokens: 128_000 });
    expect(createContextWindowObservationRepo(currentDb!).get(identity)).toMatchObject({
      windowTokens: 128_000,
      source: 'runtime-usage',
      observedAt: 400,
      originSessionId: 'session-a',
    });
  });

  it('invalidates the snapshot only when persisted provider/model changes', () => {
    const identity = runtime();
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 1_000, windowTokens: 128_000, runtimeIdentity: identity },
      100,
    );
    sessionRepo.setRuntimeProvider('session-a', 'openai');
    sessionRepo.setModel('session-a', 'gpt-a');
    expect(sessionRepo.get('session-a')?.contextUsage).not.toBeNull();

    sessionRepo.setRuntimeProvider('session-a', 'azure');
    expect(sessionRepo.get('session-a')?.contextUsage).toBeNull();
    const secondIdentity = runtime('azure', 'gpt-a');
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 2_000, windowTokens: 64_000, runtimeIdentity: secondIdentity },
      200,
    );
    sessionRepo.setModel('session-a', 'gpt-b');
    expect(sessionRepo.get('session-a')?.contextUsage).toBeNull();
  });

  it('invalidates a stale full-record upsert when runtime fields change', () => {
    const identity = runtime();
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 1_000, windowTokens: 128_000, runtimeIdentity: identity },
      100,
    );
    const stored = sessionRepo.get('session-a')!;
    sessionRepo.upsert({ ...stored, title: 'same runtime' });
    expect(sessionRepo.get('session-a')?.contextUsage).not.toBeNull();
    sessionRepo.upsert({ ...stored, runtimeProvider: 'azure' });
    expect(sessionRepo.get('session-a')?.contextUsage).toBeNull();
  });

  it('moves both snapshot and observation provenance through a session rename', () => {
    const identity = runtime();
    sessionRepo.updateContextUsage(
      'session-a',
      { usedTokens: 1_000, windowTokens: 128_000, runtimeIdentity: identity },
      100,
      {
        identity,
        windowTokens: 128_000,
        source: 'runtime-usage',
        observedAt: 100,
        originSessionId: 'session-a',
      },
    );
    renameWithDb(currentDb!, 'session-a', 'session-b');
    expect(sessionRepo.get('session-b')?.contextUsage).toMatchObject({
      runtimeIdentity: identity,
      windowTokens: 128_000,
    });
    expect(createContextWindowObservationRepo(currentDb!).get(identity)?.originSessionId)
      .toBe('session-b');
  });
});
