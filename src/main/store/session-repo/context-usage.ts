import type { Database } from 'better-sqlite3';
import type {
  ContextRuntimeIdentity,
  SessionContextUsage,
  SessionContextUsageUpdate,
} from '@shared/types';
import { createContextRuntimeIdentity } from '@main/session/context-window/identity';
import {
  createContextWindowObservationRepo,
  type ObserveContextWindowInput,
} from '../context-window-observation-repo';
import { getDb } from '../db';
import { parseSessionContextUsageJson } from './types';

export function updateContextUsage(
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
  observation?: ObserveContextWindowInput,
): SessionContextUsage | null {
  const db = getDb();
  return db.transaction(() => {
    const result = applyContextUsageWithDb(db, sessionId, update, updatedAt);
    if (result.applied && observation) {
      createContextWindowObservationRepo(db).observe(observation);
    }
    return result.usage;
  })();
}

export function updateContextUsageWithDb(
  db: Database,
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
): SessionContextUsage | null {
  return applyContextUsageWithDb(db, sessionId, update, updatedAt).usage;
}

function applyContextUsageWithDb(
  db: Database,
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
): { usage: SessionContextUsage | null; applied: boolean } {
  const row = db
    .prepare(`SELECT context_usage FROM sessions WHERE id = ?`)
    .get(sessionId) as { context_usage: string | null } | undefined;
  if (!row) return { usage: null, applied: false };

  const current = parseSessionContextUsageJson(row.context_usage, sessionId);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) {
    return { usage: current, applied: false };
  }
  const timestamp = Math.trunc(updatedAt);
  if (current && current.updatedAt > timestamp) {
    return { usage: current, applied: false };
  }
  const runtimeIdentity = normalizeRuntimeIdentityUpdate(update.runtimeIdentity);
  const identityChanged =
    update.runtimeIdentity !== undefined &&
    (current?.runtimeIdentity?.runtimeKey ?? null) !== (runtimeIdentity?.runtimeKey ?? null);
  const base = identityChanged ? null : current;
  const next: SessionContextUsage = {
    usedTokens:
      update.usedTokens === undefined
        ? base?.usedTokens ?? null
        : normalizeUsedTokens(update.usedTokens),
    windowTokens:
      update.windowTokens === undefined
        ? base?.windowTokens ?? null
        : normalizeWindowTokens(update.windowTokens),
    updatedAt: timestamp,
    runtimeIdentity:
      update.runtimeIdentity === undefined
        ? current?.runtimeIdentity ?? null
        : runtimeIdentity,
  };
  db.prepare(`UPDATE sessions SET context_usage = ? WHERE id = ?`).run(
    JSON.stringify(next),
    sessionId,
  );
  return { usage: next, applied: true };
}

function normalizeRuntimeIdentityUpdate(
  identity: ContextRuntimeIdentity | null | undefined,
): ContextRuntimeIdentity | null {
  if (identity == null) return null;
  const normalized = createContextRuntimeIdentity({
    adapter: identity.adapter,
    runtimeProvider: identity.runtimeProvider,
    model: identity.model,
    capacityConfigFingerprint: identity.capacityConfigFingerprint,
  });
  if (normalized.runtimeKey !== identity.runtimeKey) {
    throw new Error('Context usage runtime identity key mismatch');
  }
  return normalized;
}

function normalizeUsedTokens(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function normalizeWindowTokens(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0
    ? Math.trunc(value)
    : null;
}
