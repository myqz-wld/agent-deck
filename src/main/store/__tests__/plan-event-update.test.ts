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
  holder.db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at)
    VALUES('s','codex-cli','/repo','Example','sdk','active','working',1,1)`).run();
});
afterEach(() => holder.db?.close());
describe('durable plan updates', () => {
  it('updates the existing event row for one turn and retains distinct turns', () => {
    const event = (planId: string, text: string, ts: number): AgentEvent => ({
      sessionId: 's', agentId: 'codex-cli', kind: 'thinking', ts, payload: { plan: true, planId, text },
    });
    const first = eventRepo.insert(event('turn-a', 'pending', 1));
    expect(eventRepo.insert(event('turn-a', 'complete', 2))).toBe(first);
    expect(eventRepo.insert(event('turn-b', 'new', 3))).not.toBe(first);
    const rows = holder.db!.prepare('SELECT payload_json FROM events ORDER BY id').all() as { payload_json: string }[];
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].payload_json).text).toBe('complete');
  });
});
