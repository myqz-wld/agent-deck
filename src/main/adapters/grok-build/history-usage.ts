import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { tokenUsageRepo } from '@main/store/token-usage-repo';

import {
  GROK_EXTENSION_UPDATE_METHOD,
  finiteNumber,
  firstModelUsageKey,
  grokExtensionTimestampMs,
  notificationPromptId,
  parseGrokExtensionNotification,
  type GrokExtensionNotification,
  type GrokTurnUsage,
} from './extension';

const AGENT_ID = 'grok-build';

export interface GrokHistoryBackfillResult {
  files: number;
  matchedSessions: number;
  imported: number;
  affectedSessionIds: string[];
}

let defaultBackfillPromise: Promise<GrokHistoryBackfillResult> | null = null;

export function ensureGrokHistoryTokenUsage(): Promise<GrokHistoryBackfillResult> {
  if (!defaultBackfillPromise) {
    defaultBackfillPromise = backfillGrokHistoryTokenUsage({ root: join(homedir(), '.grok', 'sessions') });
  }
  return defaultBackfillPromise;
}

export async function backfillGrokHistoryTokenUsage(options: {
  root: string;
  now?: () => number;
}): Promise<GrokHistoryBackfillResult> {
  const result: GrokHistoryBackfillResult = {
    files: 0,
    matchedSessions: 0,
    imported: 0,
    affectedSessionIds: [],
  };
  const affected = new Set<string>();
  const files = await findUpdateFiles(options.root);
  result.files = files.length;

  for (const file of files) {
    const nativeSessionId = basename(dirname(file));
    const record = findGrokSession(nativeSessionId);
    if (!record) continue;
    result.matchedSessions += 1;
    let lines: string;
    try {
      lines = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of lines.split(/\r?\n/)) {
      const parsed = parseHistoryLine(line);
      if (!parsed) continue;
      const usageEvent = historyUsageEvent(
        record.id,
        record.model ?? null,
        parsed.notification,
        options.now?.() ?? Date.now(),
      );
      if (!usageEvent) continue;
      try {
        tokenUsageRepo.insert({
          sessionId: record.id,
          agentId: AGENT_ID,
          messageId: usageEvent.messageId,
          model: usageEvent.model,
          inputTokens: usageEvent.inputTokens,
          outputTokens: usageEvent.outputTokens,
          reasoningTokens: usageEvent.reasoningTokens,
          cacheReadTokens: usageEvent.cacheReadTokens,
          cacheCreationTokens: usageEvent.cacheCreationTokens,
          ts: usageEvent.ts,
        });
        result.imported += 1;
        affected.add(record.id);
      } catch {
        continue;
      }
    }
  }

  result.affectedSessionIds = [...affected];
  const ts = options.now?.() ?? Date.now();
  for (const sessionId of affected) {
    eventBus.emit('token-usage-changed', { sessionId, ts });
  }
  return result;
}

async function findUpdateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name === 'updates.jsonl') {
        files.push(path);
      }
    }
  }
  return files;
}

function findGrokSession(nativeSessionId: string) {
  try {
    const record = sessionRepo.findByCliSessionId(nativeSessionId) ?? sessionRepo.get(nativeSessionId);
    return record?.agentId === AGENT_ID ? record : null;
  } catch {
    return null;
  }
}

function parseHistoryLine(line: string): {
  notification: GrokExtensionNotification;
} | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.method !== GROK_EXTENSION_UPDATE_METHOD) return null;
  const params = parseGrokExtensionNotification(value.params);
  const timestamp = finiteNumber(value.timestamp);
  return {
    notification: {
      ...params,
      ...(timestamp !== null ? { timestamp } : {}),
    },
  };
}

function historyUsageEvent(
  sessionId: string,
  sessionModel: string | null,
  notification: GrokExtensionNotification,
  fallbackNow: number,
): {
  messageId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ts: number;
} | null {
  void sessionId;
  const update = notification.update;
  if (!update || update.sessionUpdate !== 'turn_completed' || !isUsage(update.usage)) return null;
  const messageId = notificationPromptId(notification);
  if (!messageId || !hasUsageValues(update.usage)) return null;
  const usage = update.usage;
  return {
    messageId,
    model: sessionModel?.trim() || firstModelUsageKey(usage),
    inputTokens: usageNumber(usage.inputTokens),
    outputTokens: usageNumber(usage.outputTokens),
    reasoningTokens: usageNumber(usage.reasoningTokens ?? usage.thoughtTokens),
    cacheReadTokens: usageNumber(usage.cachedReadTokens),
    cacheCreationTokens: usageNumber(usage.cachedWriteTokens),
    ts: grokExtensionTimestampMs(notification, fallbackNow),
  };
}

function isUsage(value: unknown): value is GrokTurnUsage {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUsageValues(usage: GrokTurnUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cachedReadTokens,
    usage.cachedWriteTokens,
    usage.reasoningTokens,
    usage.thoughtTokens,
  ].some((value) => finiteNumber(value) !== null);
}

function usageNumber(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
