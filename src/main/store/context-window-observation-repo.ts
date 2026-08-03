import type { Database } from 'better-sqlite3';
import type {
  ContextRuntimeIdentity,
  ContextWindowObservation,
  ContextWindowObservationSource,
} from '@shared/types';
import { createContextRuntimeIdentity } from '@main/session/context-window/identity';
import { getDb } from './db';

interface ObservationRow {
  runtime_key: string;
  identity_version: number;
  adapter: ContextRuntimeIdentity['adapter'];
  runtime_provider: string;
  model: string;
  capacity_config_fingerprint: string;
  window_tokens: number;
  source: ContextWindowObservationSource;
  observed_at: number;
  origin_session_id: string | null;
}

export interface ObserveContextWindowInput {
  identity: ContextRuntimeIdentity;
  windowTokens: number;
  source: ContextWindowObservationSource;
  observedAt: number;
  originSessionId?: string | null;
}

export interface ObserveContextWindowResult {
  applied: boolean;
  observation: ContextWindowObservation;
}

export interface ContextWindowObservationRepo {
  get(identity: ContextRuntimeIdentity): ContextWindowObservation | null;
  observe(input: ObserveContextWindowInput): ObserveContextWindowResult;
}

function observationFromRow(row: ObservationRow): ContextWindowObservation {
  if (row.identity_version !== 1) {
    throw new Error(`Unsupported context runtime identity version: ${row.identity_version}`);
  }
  const identity = createContextRuntimeIdentity({
    adapter: row.adapter,
    runtimeProvider: row.runtime_provider,
    model: row.model,
    capacityConfigFingerprint: row.capacity_config_fingerprint,
  });
  if (identity.runtimeKey !== row.runtime_key) {
    throw new Error('Stored context runtime key does not match its identity columns');
  }
  return {
    identity,
    windowTokens: row.window_tokens,
    source: row.source,
    observedAt: row.observed_at,
    originSessionId: row.origin_session_id,
  };
}

function validateObservation(input: ObserveContextWindowInput): void {
  if (!Number.isSafeInteger(input.windowTokens) || input.windowTokens <= 0) {
    throw new Error('windowTokens must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new Error('observedAt must be a non-negative safe integer');
  }
  if (input.originSessionId !== undefined && input.originSessionId !== null) {
    const sessionId = input.originSessionId.trim();
    if (!sessionId || sessionId !== input.originSessionId) {
      throw new Error('originSessionId must be a non-empty trimmed string');
    }
  }
}

export function createContextWindowObservationRepo(
  db: Database,
): ContextWindowObservationRepo {
  const select = db.prepare(
    `SELECT runtime_key, identity_version, adapter, runtime_provider, model,
            capacity_config_fingerprint, window_tokens, source, observed_at, origin_session_id
       FROM context_window_observations
      WHERE runtime_key = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO context_window_observations
       (runtime_key, identity_version, adapter, runtime_provider, model,
        capacity_config_fingerprint, window_tokens, source, observed_at, origin_session_id)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(runtime_key) DO UPDATE SET
       window_tokens = excluded.window_tokens,
       source = excluded.source,
       observed_at = excluded.observed_at,
       origin_session_id = excluded.origin_session_id
     WHERE excluded.observed_at > context_window_observations.observed_at
        OR (
          excluded.observed_at = context_window_observations.observed_at
          AND (
            CASE excluded.source
              WHEN 'runtime-usage' THEN 3
              WHEN 'runtime-metadata' THEN 2
              ELSE 1
            END
            >
            CASE context_window_observations.source
              WHEN 'runtime-usage' THEN 3
              WHEN 'runtime-metadata' THEN 2
              ELSE 1
            END
            OR (
              excluded.source = context_window_observations.source
              AND excluded.window_tokens < context_window_observations.window_tokens
            )
          )
        )`,
  );

  const get = (identity: ContextRuntimeIdentity): ContextWindowObservation | null => {
    const row = select.get(identity.runtimeKey) as ObservationRow | undefined;
    return row ? observationFromRow(row) : null;
  };

  return {
    get,
    observe(input) {
      validateObservation(input);
      const result = upsert.run(
        input.identity.runtimeKey,
        input.identity.adapter,
        input.identity.runtimeProvider,
        input.identity.model,
        input.identity.capacityConfigFingerprint,
        input.windowTokens,
        input.source,
        input.observedAt,
        input.originSessionId ?? null,
      );
      const observation = get(input.identity);
      if (!observation) throw new Error('Context-window observation upsert produced no row');
      return { applied: result.changes > 0, observation };
    },
  };
}

export function getContextWindowObservationRepo(): ContextWindowObservationRepo {
  return createContextWindowObservationRepo(getDb());
}
