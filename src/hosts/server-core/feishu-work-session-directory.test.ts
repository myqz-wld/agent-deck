import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { FeishuWorkSessionDirectory } from './feishu-work-session-directory';
import { mcpTestSession } from './mcp-server.test-fixture';
import { projectServerCoreMcpSession } from './mcp-session-visibility';

function harness(rows: SessionRecord[], assistantIds = ['assistant']) {
  const records = new Map(rows.map(row => [row.id, row]));
  const list = vi.fn((limit: number, offset: number) => rows.slice(offset, offset + limit));
  const directory = new FeishuWorkSessionDirectory({
    assistants: { read: () => [...assistantIds] },
    sessions: { get: id => records.get(id) ?? null, listActiveAndDormant: list },
    successor: original => original === 'old-assistant' ? 'successor' : null,
    project: (_caller, id) => projectServerCoreMcpSession({ workspaceRoot: '/workspace',
      sessions: { get: key => records.get(key) ?? null }, successor: () => null,
      teams: { findActiveMembershipsBySessionIds: () => new Map(), findSharedActiveTeams: () => [] },
    }, records.get(id)!),
  });
  return { directory, list, records };
}

describe('Feishu work-session identity and paging', () => {
  it('excludes assistant identities before pagination and includes dormant work with the same title/model', () => {
    const rows = ['assistant', 'prior-chat', 'dormant-work', 'active-work'].map(id => ({
      ...mcpTestSession(id, '/workspace/project', id === 'dormant-work' ? 'dormant' : 'active'),
      title: 'Identical title', model: 'same-model', codexApprovalPolicy: 'never' as const,
    }));
    const t = harness(rows, ['assistant', 'prior-chat']);
    const before = structuredClone(rows);
    const first = t.directory.list('assistant', { limit: 1 });
    expect(first).toMatchObject({ assistantSessionId: 'assistant', scope: 'open-work-sessions', hasMore: true, nextOffset: 3 });
    expect(first.sessions).toMatchObject([{ sessionId: 'dormant-work', lifecycle: 'dormant', cwd: 'project' }]);
    const second = t.directory.list('assistant', { limit: 1, offset: first.nextOffset! });
    expect(second.sessions.map(row => row.sessionId)).toEqual(['active-work']);
    expect(second).toMatchObject({ nextOffset: null, hasMore: false });
    expect(rows).toEqual(before);
  });

  it('rejects unregistered, unavailable, archived and internal callers without scanning work metadata', () => {
    for (const patch of [{ id: 'other' }, { lifecycle: 'closed' }, { archivedAt: 1 }, { hiddenFromHistory: true }]) {
      const caller = { ...mcpTestSession('assistant', '/workspace'), ...patch } as SessionRecord;
      const t = harness([caller, mcpTestSession('work', '/workspace')]);
      expect(() => t.directory.list(caller.id, {})).toThrow('Registered assistant caller');
      expect(t.list).not.toHaveBeenCalled();
    }
  });

  it('keeps handoff successors classified as assistant while excluding closed, archived and internal rows', () => {
    const t = harness([
      mcpTestSession('successor', '/workspace'),
      { ...mcpTestSession('internal', '/workspace'), hiddenFromHistory: true },
      { ...mcpTestSession('archived', '/workspace'), archivedAt: 1 },
      mcpTestSession('closed', '/workspace', 'closed'), mcpTestSession('work', '/workspace'),
    ], ['old-assistant']);
    expect(t.directory.list('successor', {}).sessions.map(row => row.sessionId)).toEqual(['work']);
  });

  it('returns a continuation instead of a false complete empty list when the scan budget is consumed', () => {
    const rows = [mcpTestSession('assistant', '/workspace'), ...Array.from({ length: 1_999 }, (_, index) => ({
      ...mcpTestSession(`internal-${index}`, '/workspace'), hiddenFromHistory: true,
    })), mcpTestSession('work', '/workspace')];
    const t = harness(rows);
    const first = t.directory.list('assistant', {});
    expect(first).toMatchObject({ sessions: [], hasMore: true, nextOffset: 2_000 });
    expect(t.list).toHaveBeenCalledTimes(10);
    expect(t.directory.list('assistant', { offset: first.nextOffset! })).toMatchObject({
      sessions: [{ sessionId: 'work' }], hasMore: false, nextOffset: null,
    });
  });
});
