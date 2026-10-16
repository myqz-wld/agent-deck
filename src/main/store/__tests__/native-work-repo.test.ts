import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentEvent } from '@shared/types';
import { chunkNativeWorkDetail, readNativeWorkDetail, type NativeWorkSnapshot } from '@shared/native-work';
import { CURRENT_SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from '../schema';
import { eventRepo } from '../event-repo';
import { createNativeWorkRepo } from '../native-work-repo';
import { createEventRevisionReadRepo } from '../event-revision-read';
const holder = { db: null as Database.Database | null };
vi.mock('@main/store/db', () => ({ getDb: () => holder.db }));
const native = { sessionId: 's', provider: 'codex-cli' as const, nativeId: 'child', runId: 'run-z', runtimeId: 'runtime-a' };
const task = (patch: Partial<NativeWorkSnapshot> = {}): NativeWorkSnapshot => ({ native, taskId: native.nativeId,
  runId: native.runId, workKind: 'subagent', status: 'running', description: 'Child', startedAt: 1,
  updatedAt: 1, revision: 1, canStop: true, detailStatus: 'available', ...patch });
const event = (kind: AgentEvent['kind'], payload: unknown, ts = 1): AgentEvent =>
  ({ sessionId: 's', agentId: 'codex-cli', kind, payload, ts, source: 'sdk' });
beforeEach(() => {
  holder.db = new Database(':memory:'); holder.db.pragma('foreign_keys = ON'); holder.db.exec(CURRENT_SCHEMA_SQL);
  holder.db.prepare(`INSERT INTO sessions(id,agent_id,cwd,title,source,lifecycle,activity,started_at,last_event_at)
    VALUES('s','codex-cli','/repo','Example','sdk','active','working',1,1)`).run();
});
afterEach(() => holder.db?.close());
describe('durable native work', () => {
  it('accepts a new runtime revision reset and rejects an old runtime\'s delayed tail', () => {
    const repo = createNativeWorkRepo(holder.db!);
    const old = task({ runtimeStartedAt: 1, revision: 100 });
    eventRepo.insert(event('background-task', old));
    const fresh = task({ native: { ...native, runtimeId: 'runtime-b' }, runtimeStartedAt: 2, updatedAt: 10 });
    eventRepo.insert(event('background-task', fresh));
    eventRepo.insert(event('background-task', { ...old, updatedAt: 20, status: 'unknown', revision: 101 }));
    expect(repo.list('s').tasks).toEqual([fresh]);
  });
  it('discovers work outside recent parent history and deduplicates without advancing revisions', () => {
    const repo = createNativeWorkRepo(holder.db!);
    const first = eventRepo.insert(event('background-task', task()));
    const revision = repo.list('s').revision;
    expect(eventRepo.insert(event('background-task', task()))).toBe(first);
    expect(repo.list('s').revision).toBe(revision);
    for (let i = 0; i < 250; i++) eventRepo.insert(event('message', { role: 'assistant', text: 'parent' }, i + 10));
    expect(eventRepo.listForSession('s')).toHaveLength(200);
    expect(repo.list('s').tasks).toEqual([task()]);
    eventRepo.insert(event('finished', {}));
    expect(repo.list('s').tasks[0].status).toBe('running');
  });
  it('orders attempts by observed start rather than lexical run ID and rejects late revival', () => {
    const repo = createNativeWorkRepo(holder.db!);
    eventRepo.insert(event('background-task', task()));
    const next = task({ native: { ...native, runId: 'run-a' }, runId: 'run-a', startedAt: 20, updatedAt: 20 });
    eventRepo.insert(event('background-task', next));
    eventRepo.insert(event('background-task', task({ updatedAt: 99, revision: 4 })));
    expect(repo.list('s').tasks).toEqual([next]);
    eventRepo.insert(event('background-task', { ...next, status: 'completed', revision: 2, updatedAt: 30 }));
    eventRepo.insert(event('background-task', { ...next, status: 'running', revision: 3, updatedAt: 40 }));
    expect(repo.list('s').tasks[0].status).toBe('completed');
  });
  it('keeps child tool identity separate, filters before parent limits and retains multilingual pages', () => {
    const repo = createNativeWorkRepo(holder.db!);
    eventRepo.insert(event('tool-use-start', { toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'parent' } }));
    const text = '你好🌏 café\n'.repeat(40000);
    const chunks = chunkNativeWorkDetail({ native, recordId: 'tool-1', recordRevision: 1,
      kind: 'tool-use-start', text, ts: 1, sourceTruncated: true });
    for (const chunk of chunks) {
      expect(readNativeWorkDetail(chunk)).not.toBeNull();
      eventRepo.insert(event('native-work-detail', chunk));
      eventRepo.insert(event('native-work-detail', chunk));
    }
    expect(eventRepo.listForSession('s', 1)[0].kind).toBe('tool-use-start');
    expect(eventRepo.countForSession('s')).toBe(1);
    expect(createEventRevisionReadRepo(holder.db!).listRawEvents({ sessionId: 's', throughRevision: repo.list('s').revision }))
      .toHaveLength(1);
    let cursor: number | undefined, output = '';
    do {
      const page = repo.details({ ref: native, cursor, limit: 7 });
      output += page.records.map(row => row.text).join('');
      expect(page.records.every(row => row.sourceTruncated)).toBe(true);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(output).toBe(text);
    expect(repo.details({ ref: { ...native, nativeId: 'other-child' } }).records).toEqual([]);
  });
  it('removes replaced output tails, rejects malformed ownership and cascades with its parent', () => {
    const repo = createNativeWorkRepo(holder.db!);
    const base = { native, recordId: 'message-1', recordRevision: 1, kind: 'message' as const,
      text: 'x'.repeat(40000), ts: 1, sourceTruncated: false };
    const old = chunkNativeWorkDetail(base);
    old.forEach(payload => eventRepo.insert(event('native-work-detail', payload)));
    chunkNativeWorkDetail({ ...base, recordRevision: 2, text: 'short' }).forEach(payload => eventRepo.insert(event('native-work-detail', payload)));
    old.forEach(payload => eventRepo.insert(event('native-work-detail', payload)));
    expect(repo.details({ ref: native }).records.map(row => row.text)).toEqual(['short']);
    expect(() => eventRepo.insert(event('native-work-detail', { ...old[0], native: { ...native, sessionId: 'other' } }))).toThrow('owner');
    expect(readNativeWorkDetail({ ...old[0], text: { nested: 'bad' } })).toBeNull();
    holder.db!.prepare('DELETE FROM sessions WHERE id = ?').run('s');
    expect(repo.details({ ref: native }).records).toEqual([]);
    expect(CURRENT_SCHEMA_VERSION).toBe(62);
  });
});
