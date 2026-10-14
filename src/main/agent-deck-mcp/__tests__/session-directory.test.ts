import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { collectSessionDirectory, type SessionDirectoryRepository } from '../session-directory';

function row(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id, title: id, agentId: 'codex-cli', cwd: '/workspace', source: 'sdk',
    lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 1,
    endedAt: null, archivedAt: null, ...overrides };
}

function repository(rows: SessionRecord[]): SessionDirectoryRepository {
  const sorted = [...rows].sort((a, b) => b.lastEventAt - a.lastEventAt);
  return {
    listActiveAndDormant: (limit, offset, lifecycle) => sorted.filter((r) =>
      r.archivedAt === null && r.lifecycle !== 'closed' && (!lifecycle || r.lifecycle === lifecycle))
      .slice(offset, offset + limit),
    // Preserve the real History repository's per-query cap in this regression.
    listHistory: ({ limit, offset }) => sorted.filter((r) => r.lifecycle === 'closed' || r.archivedAt !== null)
      .slice(offset, offset + Math.min(500, limit)),
  };
}

describe('session metadata directory', () => {
  it('collects open metadata accepted by the visibility predicate and excludes hidden/archived rows', () => {
    const repo = repository([row('active'), row('dormant', { lifecycle: 'dormant' }),
      row('closed', { lifecycle: 'closed' }), row('internal', { hiddenFromHistory: true }),
      row('archived', { archivedAt: 1 })]);
    expect(collectSessionDirectory(repo, {}, () => true).page.map((r) => r.id))
      .toEqual(['active', 'dormant']);
  });

  it.each(['all', 'closed'] as const)('pages all 650 history rows with status %s', (statusFilter) => {
    const repo = repository(Array.from({ length: 650 }, (_, i) => row(`row-${i}`, {
      lifecycle: 'closed', lastEventAt: 1000 - i,
    })));
    expect(collectSessionDirectory(repo, { statusFilter, limit: 100, offset: 400 }, () => true))
      .toMatchObject({ hasMore: true, page: expect.any(Array) });
    const later = collectSessionDirectory(repo, { statusFilter, limit: 100, offset: 500 }, () => true);
    expect(later.page).toHaveLength(100);
    expect(later.page[0].id).toBe('row-500');
    expect(later.hasMore).toBe(true);
    expect(collectSessionDirectory(repo, { statusFilter, limit: 100, offset: 600 }, () => true).hasMore).toBe(false);
  });

  it('merges interleaved lifecycles and paginates after relation and explicit filters', () => {
    const rows = Array.from({ length: 900 }, (_, i) => row(`row-${i}`, {
      lifecycle: i % 2 ? 'closed' : 'active', lastEventAt: 1000 - i,
      spawnedBy: i % 3 ? 'other' : 'parent',
    }));
    const result = collectSessionDirectory(repository(rows), {
      statusFilter: 'all', spawnedByFilter: 'parent', limit: 2, offset: 50,
    }, (r) => Number(r.id.slice(4)) % 6 === 0);
    expect(result.page.map((r) => r.id)).toEqual(['row-300', 'row-306']);
    expect(result.hasMore).toBe(true);
  });
});
