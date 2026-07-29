import type { Database } from 'better-sqlite3';
import type { TokenDailyRow } from '@shared/types';
import {
  mapTokenDailyRows,
  queryTokenUsageDaily,
  type TokenDailySqlRow,
} from './token-usage-daily-query';

type RawDailyQuery = (
  db: Database,
  fromMs?: number,
  toMs?: number,
) => TokenDailyRow[];

export interface TokenUsageDailyRollupOptions {
  rawQuery?: RawDailyQuery;
  timezoneFingerprint?: () => string;
}

export interface TokenUsageDailyRollup {
  read(): TokenDailyRow[];
  reset(): void;
}

interface ProjectionState {
  sourceRevision: number;
  projectionRevision: number;
  timezoneFingerprint: string | null;
  fullRebuildRequired: number;
}

interface ProjectionCache {
  sourceRevision: number;
  timezoneFingerprint: string;
  rows: TokenDailyRow[];
}

interface CurrentProjection {
  state: ProjectionState;
  rows: TokenDailyRow[] | null;
}

export function createTokenUsageDailyRollup(
  db: Database,
  options: TokenUsageDailyRollupOptions = {},
): TokenUsageDailyRollup {
  const rawQuery = options.rawQuery ?? queryTokenUsageDaily;
  const fingerprint = options.timezoneFingerprint ?? currentTimezoneFingerprint;
  let cache: ProjectionCache | null = null;
  let fullRawFallback: TokenDailyRow[] | null = null;

  const insertProjection = db.prepare(
    `INSERT INTO token_usage_daily_rollup (
       day, model_bucket, sort_order,
       provider_total_tokens, provider_total_applicable,
       input_tokens, input_applicable, input_total_tokens, input_total_applicable,
       output_tokens, output_applicable, reasoning_tokens, reasoning_applicable,
       cache_read_tokens, cache_read_applicable,
       cache_creation_tokens, cache_creation_applicable
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const project = db.transaction((timezoneFingerprint: string): TokenDailyRow[] => {
    const state = readState(db);
    const dirtyDays = readDirtyDays(db);
    const needsFull =
      state.fullRebuildRequired === 1 ||
      state.timezoneFingerprint !== timezoneFingerprint ||
      state.projectionRevision < 0 ||
      (state.projectionRevision !== state.sourceRevision && dirtyDays.length === 0);

    if (needsFull) {
      const rows = rawQuery(db);
      fullRawFallback = rows;
      db.prepare('DELETE FROM token_usage_daily_rollup').run();
      writeProjectionRows(rows);
    } else {
      for (const day of dirtyDays) {
        const { fromMs, toMs } = localDayBounds(day);
        const rows = rawQuery(db, fromMs, toMs);
        db.prepare('DELETE FROM token_usage_daily_rollup WHERE day = ?').run(day);
        writeProjectionRows(rows);
      }
    }

    db.prepare('DELETE FROM token_usage_daily_dirty_days').run();
    db.prepare(
      `UPDATE token_usage_daily_state
          SET projection_revision = source_revision,
              timezone_fingerprint = ?,
              full_rebuild_required = 0
        WHERE singleton = 1`,
    ).run(timezoneFingerprint);
    return readProjection(db);
  });
  const readCurrent = db.transaction(
    (timezoneFingerprint: string): CurrentProjection | null => {
      const state = readState(db);
      const projectionCurrent =
        state.fullRebuildRequired === 0 &&
        state.timezoneFingerprint === timezoneFingerprint &&
        state.projectionRevision === state.sourceRevision &&
        !hasDirtyDays(db);
      if (!projectionCurrent) return null;
      const cached =
        cache?.sourceRevision === state.sourceRevision &&
        cache.timezoneFingerprint === timezoneFingerprint;
      return {
        state,
        rows: cached ? null : readProjection(db),
      };
    },
  );

  function writeProjectionRows(rows: TokenDailyRow[]): void {
    let currentDay = '';
    let sortOrder = 0;
    for (const row of rows) {
      if (row.day !== currentDay) {
        currentDay = row.day;
        sortOrder = 0;
      }
      insertProjection.run(
        row.day,
        row.bucketKey,
        sortOrder++,
        row.providerTotalTokens,
        Number(row.providerTotalApplicable),
        row.inputTokens,
        Number(row.inputApplicable),
        row.inputTotalTokens,
        Number(row.inputTotalApplicable),
        row.outputTokens,
        Number(row.outputApplicable),
        row.reasoningTokens,
        Number(row.reasoningApplicable),
        row.cacheReadTokens,
        Number(row.cacheReadApplicable),
        row.cacheCreationTokens,
        Number(row.cacheCreationApplicable),
      );
    }
  }

  function read(): TokenDailyRow[] {
    const timezoneFingerprint = fingerprint();
    let current: CurrentProjection | null;
    try {
      current = readCurrent.deferred(timezoneFingerprint);
    } catch {
      cache = null;
      return rawQuery(db);
    }
    if (current) {
      if (current.rows === null && cache) {
        return cache.rows;
      }
      const rows = current.rows ?? [];
      cache = {
        sourceRevision: current.state.sourceRevision,
        timezoneFingerprint,
        rows,
      };
      return rows;
    }

    try {
      fullRawFallback = null;
      const rows = project.immediate(timezoneFingerprint);
      fullRawFallback = null;
      const committed = readState(db);
      cache = {
        sourceRevision: committed.sourceRevision,
        timezoneFingerprint,
        rows,
      };
      return rows;
    } catch {
      cache = null;
      // Projection failure must not expose stale materialized rows. Reuse a complete raw snapshot
      // computed in the failed transaction; otherwise query raw after rollback and surface failure.
      const fallback = fullRawFallback;
      fullRawFallback = null;
      return fallback ?? rawQuery(db);
    }
  }

  return {
    read,
    reset: () => {
      cache = null;
    },
  };
}

function readState(db: Database): ProjectionState {
  return db.prepare(
    `SELECT source_revision AS sourceRevision,
            projection_revision AS projectionRevision,
            timezone_fingerprint AS timezoneFingerprint,
            full_rebuild_required AS fullRebuildRequired
       FROM token_usage_daily_state
      WHERE singleton = 1`,
  ).get() as ProjectionState;
}

function readDirtyDays(db: Database): string[] {
  return (
    db.prepare(
      'SELECT day FROM token_usage_daily_dirty_days ORDER BY day',
    ).all() as Array<{ day: string }>
  ).map(({ day }) => day);
}

function hasDirtyDays(db: Database): boolean {
  return db.prepare(
    'SELECT 1 FROM token_usage_daily_dirty_days LIMIT 1',
  ).get() !== undefined;
}

function readProjection(db: Database): TokenDailyRow[] {
  const rows = db.prepare(
    `SELECT model_bucket AS bucketKey, day,
            provider_total_tokens AS providerTotalTokens,
            provider_total_applicable AS providerTotalApplicable,
            input_tokens AS inputTokens,
            input_applicable AS inputApplicable,
            input_total_tokens AS inputTotalTokens,
            input_total_applicable AS inputTotalApplicable,
            output_tokens AS outputTokens,
            output_applicable AS outputApplicable,
            reasoning_tokens AS reasoningTokens,
            reasoning_applicable AS reasoningApplicable,
            cache_read_tokens AS cacheReadTokens,
            cache_read_applicable AS cacheReadApplicable,
            cache_creation_tokens AS cacheCreationTokens,
            cache_creation_applicable AS cacheCreationApplicable
       FROM token_usage_daily_rollup
      ORDER BY day DESC, sort_order`,
  ).all() as TokenDailySqlRow[];
  return mapTokenDailyRows(rows);
}

export function localDayBounds(day: string): { fromMs: number; toMs: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error('Invalid local token-usage day');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const date = Number(match[3]);
  const start = new Date(year, monthIndex, date);
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== monthIndex ||
    start.getDate() !== date
  ) {
    throw new Error('Invalid local token-usage day');
  }
  return {
    fromMs: start.getTime(),
    toMs: new Date(year, monthIndex, date + 1).getTime(),
  };
}

export function currentTimezoneFingerprint(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '<unknown>';
  const tzVersion = (
    process.versions as NodeJS.ProcessVersions & { tz?: string }
  ).tz ?? '<unknown>';
  const probes = [
    Date.UTC(1970, 0, 1),
    Date.UTC(2000, 0, 1),
    Date.UTC(2000, 6, 1),
    Date.UTC(2020, 0, 1),
    Date.UTC(2020, 6, 1),
    Date.UTC(2030, 0, 1),
    Date.UTC(2030, 6, 1),
    Date.UTC(2050, 0, 1),
    Date.UTC(2050, 6, 1),
  ].map((value) => new Date(value).getTimezoneOffset());
  return JSON.stringify({ zone, tzVersion, probes });
}
