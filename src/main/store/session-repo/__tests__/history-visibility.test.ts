import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '@shared/types';
import { bindingAvailable, makeMemoryDb } from './_setup';

let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('history visibility test database is not ready');
    return currentDb;
  },
}));

import { sessionRepo } from '../index';

function record(id: string, hiddenFromHistory: boolean): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle: 'closed',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: hiddenFromHistory ? 3 : 2,
    endedAt: 4,
    archivedAt: null,
    hiddenFromHistory,
  };
}

describe.skipIf(!bindingAvailable)('session History visibility', () => {
  beforeEach(() => {
    currentDb = makeMemoryDb();
  });

  afterEach(() => {
    currentDb?.close();
    currentDb = null;
  });

  it('excludes internal review sessions from every History query', () => {
    sessionRepo.upsert(record('visible', false));
    sessionRepo.upsert(record('hidden-review', true));

    expect(sessionRepo.listHistory().map((item) => item.id)).toEqual(['visible']);
    expect(sessionRepo.listHistory({ agentId: 'codex-cli' }).map((item) => item.id))
      .toEqual(['visible']);
    expect(sessionRepo.listHistory({ cwd: '/repo' }).map((item) => item.id))
      .toEqual(['visible']);
  });

  it('keeps hidden visibility monotonic across stale full-record upserts', () => {
    sessionRepo.upsert(record('review-child', false));
    sessionRepo.hideFromHistory('review-child');
    const stale = record('review-child', false);

    sessionRepo.upsert(stale);

    expect(sessionRepo.get('review-child')?.hiddenFromHistory).toBe(true);
    expect(sessionRepo.listHistory()).toEqual([]);
  });
});
