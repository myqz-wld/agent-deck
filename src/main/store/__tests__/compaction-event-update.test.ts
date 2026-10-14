import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentEvent } from '@shared/types';
import { CURRENT_SCHEMA_SQL } from '../schema';
import { eventRepo } from '../event-repo';

const holder = { db: null as Database.Database | null };
vi.mock('@main/store/db', () => ({ getDb: () => holder.db }));
beforeEach(() => {
  holder.db = new Database(':memory:');
  holder.db.pragma('foreign_keys = ON');
  holder.db.exec(CURRENT_SCHEMA_SQL);
  for (const id of ['a', 'b']) holder.db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at)
    VALUES(?,'grok-build','/repo','Example','sdk','active','working',1,1)`).run(id);
});
afterEach(() => holder.db?.close());

describe('durable compaction snapshots', () => {
  const event = (id: string, summary: string, ts: number, sessionId = 'a', kind: AgentEvent['kind'] = 'message'): AgentEvent => ({
    sessionId, agentId: 'grok-build', kind, ts,
    payload: { role: 'system', compaction: { id, status: 'running', summary } },
  });
  it('coalesces streamed summaries without losing lifecycle edges or crossing sessions/IDs', () => {
    eventRepo.insert(event('compact-a', '', 1, 'a', 'context-compaction-start'));
    const first = eventRepo.insert(event('compact-a', 'first', 2));
    expect(eventRepo.insert(event('compact-a', 'first second', 3))).toBe(first);
    eventRepo.insert(event('compact-a', 'first second', 4, 'a', 'context-compaction-end'));
    expect(eventRepo.insert(event('compact-a', '', 5))).toBe(first);
    expect(eventRepo.insert(event('compact-a', 'foreign', 6, 'b'))).not.toBe(first);
    expect(eventRepo.insert(event('compact-b', 'next', 7))).not.toBe(first);
    const rows = holder.db!.prepare('SELECT id, kind, payload_json FROM events ORDER BY id').all() as { id: number; kind: string; payload_json: string }[];
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.kind)).toContain('context-compaction-start');
    expect(rows.map((row) => row.kind)).toContain('context-compaction-end');
    expect(JSON.parse(rows.find((row) => row.id === first)!.payload_json).compaction.summary).toBe('');
  });
});
