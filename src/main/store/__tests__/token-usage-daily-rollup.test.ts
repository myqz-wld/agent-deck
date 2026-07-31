import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_USAGE_ALL_METRICS, TOKEN_USAGE_METRIC } from '@shared/types';

import { bindingAvailable, makeMemoryDb } from './agent-deck-repos/_setup';
import { createTokenUsageRepo, type TokenUsageRepo } from '../token-usage-repo';
import { queryTokenUsageDaily } from '../token-usage-daily-query';
import { buildTokenUsageDailyQuery } from '../token-usage-daily-query';
import {
  createTokenUsageDailyRollup,
  currentTimezoneFingerprint,
  localDayBounds,
} from '../token-usage-daily-rollup';

const openDbs: Database.Database[] = [];

function makeRepo(): { db: Database.Database; repo: TokenUsageRepo } {
  const db = makeMemoryDb();
  openDbs.push(db);
  return { db, repo: createTokenUsageRepo(db) };
}

function usage(
  over: Partial<Parameters<TokenUsageRepo['insert']>[0]> = {},
): Parameters<TokenUsageRepo['insert']>[0] {
  return {
    sessionId: 's',
    agentId: 'claude-code',
    messageId: 'm',
    model: 'claude-opus-4-8',
    totalTokens: null,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 1,
    cacheReadTokens: 2,
    cacheCreationTokens: 3,
    ts: new Date(2026, 5, 1, 12).getTime(),
    ...over,
  };
}

function projectionState(db: Database.Database): {
  source: number;
  projection: number;
  full: number;
  dirty: number;
  timezone: string | null;
} {
  return db.prepare(
    `SELECT source_revision AS source, projection_revision AS projection,
            full_rebuild_required AS full, timezone_fingerprint AS timezone,
            (SELECT COUNT(*) FROM token_usage_daily_dirty_days) AS dirty
       FROM token_usage_daily_state WHERE singleton = 1`,
  ).get() as ReturnType<typeof projectionState>;
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  vi.restoreAllMocks();
});

describe.skipIf(!bindingAvailable)('token usage daily rollup', () => {
  it('keeps the extracted raw production SQL byte-for-byte identical', () => {
    expect(
      createHash('sha256')
        .update(buildTokenUsageDailyQuery().sql)
        .digest('hex'),
    ).toBe('c780f050ab3f241f35a4e9ebb9a16444f5c3326b39d2c65bff244f35fb65d539');
  });

  it('keeps raw SQL parity for mixed adapters, NULL/scope/zero fields, and ordering', () => {
    const { db, repo } = makeRepo();
    const noon = new Date(2026, 5, 1, 12).getTime();
    repo.insert(usage({ messageId: 'claude', ts: noon }));
    repo.insert(usage({
      agentId: 'codex-cli',
      messageId: null,
      model: 'gpt-5.6-sol',
      inputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 7,
      cacheCreationTokens: null,
      metricScope: TOKEN_USAGE_ALL_METRICS & ~TOKEN_USAGE_METRIC.cacheCreation,
      ts: noon + 1,
    }));
    repo.insert(usage({
      messageId: 'reasoning',
      model: 'claude-unattributed-reasoning',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: 9,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      metricScope: TOKEN_USAGE_METRIC.reasoning,
      ts: noon + 2,
    }));
    repo.insert(usage({
      agentId: 'grok-build',
      messageId: 'grok',
      model: 'grok-4.5',
      totalTokens: 19,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: noon + 3,
    }));

    const expected = queryTokenUsageDaily(db);
    expect(repo.dailyByModel()).toEqual(expected);
    expect(repo.dailyByModel()).toEqual(expected);
    expect(projectionState(db)).toMatchObject({
      source: 4,
      projection: 4,
      full: 0,
      dirty: 0,
    });
  });

  it('always uses the authoritative raw query for bounded calls', () => {
    const { db, repo } = makeRepo();
    const day = new Date(2026, 5, 1, 12).getTime();
    repo.insert(usage({ ts: day }));
    const bounded = repo.dailyByModel(day - 1, day + 1);
    expect(bounded).toEqual(queryTokenUsageDaily(db, day - 1, day + 1));
    expect(projectionState(db).projection).toBe(-1);
  });

  it('does not revise or dirty the projection for an unchanged same-message UPSERT', () => {
    const { db, repo } = makeRepo();
    const row = usage();
    repo.insert(row);
    expect(projectionState(db).source).toBe(1);
    repo.insert(row);
    expect(projectionState(db).source).toBe(1);
    repo.insert({ ...row, outputTokens: 8 });
    expect(projectionState(db).source).toBe(2);
  });

  it('rebuilds dirty OLD+NEW buckets after Grok replacement and GC/delete', () => {
    const { db, repo } = makeRepo();
    const first = new Date(2026, 5, 1, 12).getTime();
    const second = new Date(2026, 5, 2, 12).getTime();
    repo.insert(usage({
      sessionId: 'g',
      agentId: 'grok-build',
      messageId: 'grok-standard:g:1',
      model: 'grok-4.5',
      ts: first,
    }));
    expect(repo.dailyByModel()).toEqual(queryTokenUsageDaily(db));
    repo.insert(usage({
      sessionId: 'g',
      agentId: 'grok-build',
      messageId: 'provider-1',
      replacesMessageId: 'grok-standard:g:1',
      model: 'grok-4.5',
      outputTokens: 8,
      ts: second,
    }));
    expect(projectionState(db)).toMatchObject({ source: 3, projection: 1, dirty: 2 });
    expect(repo.dailyByModel()).toEqual(queryTokenUsageDaily(db));
    expect(repo.deleteOlderThan(second + 1)).toBe(1);
    expect(repo.dailyByModel()).toEqual([]);
    expect(projectionState(db)).toMatchObject({ source: 4, projection: 4, dirty: 0 });
  });

  it('rolls back dirty projection failures, returns raw truth, and retries after restart', () => {
    const { db, repo } = makeRepo();
    repo.insert(usage());
    repo.dailyByModel();
    repo.insert(usage({ outputTokens: 8 }));
    db.exec(
      `CREATE TRIGGER fail_daily_projection
       BEFORE INSERT ON token_usage_daily_rollup
       BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END`,
    );
    const expected = queryTokenUsageDaily(db);
    expect(repo.dailyByModel()).toEqual(expected);
    expect(projectionState(db)).toMatchObject({
      source: 2,
      projection: 1,
      full: 0,
      dirty: 1,
    });
    db.exec('DROP TRIGGER fail_daily_projection');
    expect(createTokenUsageRepo(db).dailyByModel()).toEqual(expected);
    expect(projectionState(db)).toMatchObject({
      source: 2,
      projection: 2,
      full: 0,
      dirty: 0,
    });
  });

  it('returns an already-computed full raw snapshot when projection persistence fails', () => {
    const { db, repo } = makeRepo();
    repo.insert(usage());
    const expected = queryTokenUsageDaily(db);
    const raw = vi.fn(queryTokenUsageDaily);
    const rollup = createTokenUsageDailyRollup(db, { rawQuery: raw });
    db.exec(
      `CREATE TRIGGER fail_full_daily_projection
       BEFORE INSERT ON token_usage_daily_rollup
       BEGIN SELECT RAISE(ABORT, 'forced full projection failure'); END`,
    );
    expect(rollup.read()).toEqual(expected);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(projectionState(db)).toMatchObject({
      source: 1,
      projection: -1,
      full: 1,
      dirty: 1,
    });
    db.exec('DROP TRIGGER fail_full_daily_projection');
  });

  it('falls back to raw truth on BUSY and retains rebuild work for retry', () => {
    const root = mkdtempSync('/tmp/agent-deck-rollup-busy-');
    const dbPath = join(root, 'busy.db');
    const db = makeMemoryDb(dbPath);
    const locker = new Database(dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 0');
      locker.pragma('journal_mode = WAL');
      locker.pragma('busy_timeout = 0');
      const repo = createTokenUsageRepo(db);
      repo.insert(usage());
      const expected = queryTokenUsageDaily(db);
      locker.exec('BEGIN IMMEDIATE');
      expect(repo.dailyByModel()).toEqual(expected);
      expect(projectionState(db)).toMatchObject({
        source: 1,
        projection: -1,
        dirty: 1,
      });
      locker.exec('ROLLBACK');
      expect(repo.dailyByModel()).toEqual(expected);
      expect(projectionState(db)).toMatchObject({
        source: 1,
        projection: 1,
        dirty: 0,
      });
    } finally {
      if (locker.inTransaction) locker.exec('ROLLBACK');
      locker.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses committed revision cache hits and forces a rebuild on timezone mismatch', () => {
    const { db, repo } = makeRepo();
    repo.insert(usage());
    const raw = vi.fn(queryTokenUsageDaily);
    let fingerprint = 'zone-a';
    const rollup = createTokenUsageDailyRollup(db, {
      rawQuery: raw,
      timezoneFingerprint: () => fingerprint,
    });
    const expected = rollup.read();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(rollup.read()).toEqual(expected);
    expect(raw).toHaveBeenCalledTimes(1);
    const restartedRaw = vi.fn(queryTokenUsageDaily);
    const restarted = createTokenUsageDailyRollup(db, {
      rawQuery: restartedRaw,
      timezoneFingerprint: () => fingerprint,
    });
    expect(restarted.read()).toEqual(expected);
    expect(restartedRaw).not.toHaveBeenCalled();

    fingerprint = 'zone-b';
    expect(rollup.read()).toEqual(expected);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(projectionState(db).timezone).toBe('zone-b');
    rollup.reset();
    expect(rollup.read()).toEqual(expected);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('fingerprints stable zone rules and computes DST day bounds by calendar', () => {
    const original = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(currentTimezoneFingerprint()).toBe(currentTimezoneFingerprint());
      const spring = localDayBounds('2026-03-08');
      const fall = localDayBounds('2026-11-01');
      expect(spring.toMs - spring.fromMs).toBe(23 * 60 * 60 * 1000);
      expect(fall.toMs - fall.fromMs).toBe(25 * 60 * 60 * 1000);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
