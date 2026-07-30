import type { Database } from 'better-sqlite3';
import type {
  SessionContextUsage,
  SessionContextUsageUpdate,
} from '@shared/types';
import { getDb } from '../db';
import { parseSessionContextUsageJson } from './types';

export function updateContextUsage(
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
): SessionContextUsage | null {
  return updateContextUsageWithDb(getDb(), sessionId, update, updatedAt);
}

export function updateContextUsageWithDb(
  db: Database,
  sessionId: string,
  update: SessionContextUsageUpdate,
  updatedAt: number,
): SessionContextUsage | null {
  const row = db
    .prepare(`SELECT context_usage FROM sessions WHERE id = ?`)
    .get(sessionId) as { context_usage: string | null } | undefined;
  if (!row) return null;

  const current = parseSessionContextUsageJson(row.context_usage, sessionId);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return current;
  const timestamp = Math.trunc(updatedAt);
  if (current && current.updatedAt > timestamp) return current;
  const next: SessionContextUsage = {
    usedTokens:
      update.usedTokens === undefined
        ? current?.usedTokens ?? null
        : normalizeUsedTokens(update.usedTokens),
    windowTokens:
      update.windowTokens === undefined
        ? current?.windowTokens ?? null
        : normalizeWindowTokens(update.windowTokens),
    updatedAt: timestamp,
  };
  db.prepare(`UPDATE sessions SET context_usage = ? WHERE id = ?`).run(
    JSON.stringify(next),
    sessionId,
  );
  return next;
}

function normalizeUsedTokens(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function normalizeWindowTokens(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}
