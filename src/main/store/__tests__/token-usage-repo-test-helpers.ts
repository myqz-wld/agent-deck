import type Database from 'better-sqlite3';

import { createTokenUsageRepo, type TokenUsageRepo } from '../token-usage-repo';
import {
  bindingAvailable,
  insertSession,
  makeMemoryDb,
} from './agent-deck-repos/_setup';

export { bindingAvailable, insertSession };

export function makeRepo(): {
  db: Database.Database;
  repo: TokenUsageRepo;
} {
  const db = makeMemoryDb(':memory:', 55);
  return { db, repo: createTokenUsageRepo(db) };
}

export function usage(
  over: Partial<Parameters<TokenUsageRepo['insert']>[0]> = {},
): Parameters<TokenUsageRepo['insert']>[0] {
  return {
    sessionId: 'sess-1',
    agentId: 'claude-code',
    messageId: 'm1',
    model: 'claude-opus-4-8',
    totalTokens: null,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    ts: 1_000_000,
    ...over,
  };
}
