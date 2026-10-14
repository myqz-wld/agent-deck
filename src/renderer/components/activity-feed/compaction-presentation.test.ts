import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { readCompaction } from '@shared/compaction';
import { presentCompactions } from './compaction-presentation';

const e = (id: number, kind: AgentEvent['kind'], payload: unknown, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id, sessionId: 'session-a', agentId: 'codex-cli', kind, payload, ts: id * 1000, ...overrides,
} as AgentEvent);
const start = (id: number, compactionId?: string) => e(id, 'context-compaction-start', { compactionId });
const end = (id: number, compactionId?: string) => e(id, 'context-compaction-end', { compactionId });

describe('compaction timeline projection', () => {
  it('updates the initial position and retains intervening conversation order and raw evidence', () => {
    const first = start(1, 'a');
    const text = e(2, 'message', { role: 'assistant', text: 'continuing' });
    const events = [end(3, 'a'), text, first];
    const before = JSON.stringify(events);
    const rows = presentCompactions(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(text);
    expect(rows[1].ts).toBe(first.ts);
    expect(readCompaction(rows[1])).toMatchObject({ status: 'completed', startedAt: 1000, durationMs: 2000 });
    expect(JSON.stringify(events)).toBe(before);
  });
  it('pairs legacy edges but keeps consecutive operations and sessions separate', () => {
    const foreign = e(4, 'context-compaction-end', {}, { sessionId: 'session-b' });
    const rows = presentCompactions([end(6), start(5), foreign, end(3), start(1)]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => readCompaction(row)?.status)).toEqual(['completed', 'completed', 'completed']);
    expect(readCompaction(rows[1])?.durationMs).toBeUndefined();
  });
  it('fences native IDs and provider owners when updates interleave', () => {
    const rows = presentCompactions([end(6, 'b'), end(5, 'a'), start(4, 'b'),
      e(3, 'context-compaction-start', { compactionId: 'a' }, { agentId: 'grok-build' }), start(1, 'a')]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => readCompaction(row)?.status)).toEqual(['completed', 'running', 'completed']);
  });
  it('closes every pending row on a turn boundary without claiming unobserved success', () => {
    for (const [payload, status] of [[{ ok: false, subtype: 'interrupted' }, 'interrupted'],
      [{ ok: false, subtype: 'error' }, 'failed'], [{ ok: true }, 'unknown']] as const) {
      const rows = presentCompactions([e(3, 'finished', payload), start(2, 'b'), start(1, 'a')]);
      expect(rows.slice(1).map((row) => readCompaction(row)?.status)).toEqual([status, status]);
    }
  });
  it('uses revision for same-millisecond snapshots and supports summary clearing', () => {
    const patch = e(2, 'message', { role: 'system', compaction: { id: 'a', status: 'completed', summary: '', revision: 3 } }, { ts: 3000 });
    const terminal = e(3, 'context-compaction-end', { compaction: { id: 'a', status: 'completed', summary: 'old', revision: 2 } });
    const rows = presentCompactions([terminal, patch, start(1, 'a')]);
    expect(rows).toHaveLength(1);
    expect(readCompaction(rows[0])).toMatchObject({ summary: '', revision: 3, status: 'completed' });
  });
  it('does not invent elapsed time in partial history or merge across restarts', () => {
    expect(readCompaction(presentCompactions([end(5, 'a')])[0])?.durationMs).toBeUndefined();
    expect(presentCompactions([end(6, 'a'), start(5, 'a'), e(4, 'session-start', {}), end(3, 'a'), start(1, 'a')])).toHaveLength(3);
  });
  it('retains late summary chunks without reopening an interrupted compaction', () => {
    const chunk = e(4, 'message', { role: 'system', compactionSummaryOnly: true,
      compaction: { id: 'a', status: 'running', summary: 'late summary', revision: 2 } });
    const rows = presentCompactions([chunk, e(3, 'finished', { ok: false, subtype: 'interrupted' }), start(1, 'a')]);
    expect(rows).toHaveLength(2);
    expect(readCompaction(rows[1])).toMatchObject({ status: 'interrupted', summary: 'late summary' });
  });
});
