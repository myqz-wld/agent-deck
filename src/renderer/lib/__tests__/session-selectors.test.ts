/**
 * REVIEW_107 Batch 9 回归测试 — selectPendingBuckets（session-selectors.ts）。
 *
 * 该 selector 此前 0 测试，但 REVIEW_107 MED（reviewer-codex）的 PendingSection 修法依赖它
 * 继承 archivedAt + lifecycle 过滤口径（PendingSection 原先自行按 member leftAt 聚合 → 漏掉
 * archived / 非活跃 session 的残留 pending → 与 PendingTab 口径漂移，导向不可处理会话）。
 * 本测试锁住该 selector 的过滤 + 排序契约，防 PendingSection 复用的口径回归。
 */
import { describe, expect, it } from 'vitest';
import type { PermissionRequest, SessionRecord } from '@shared/types';
import { selectLiveSessions, selectPendingBuckets } from '../session-selectors';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-test',
    agentId: 'claude-code',
    cwd: '/test',
    title: 'Test Session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } as SessionRecord;
}

function perm(requestId: string): PermissionRequest {
  return { type: 'permission-request', requestId, toolName: 'Bash', toolInput: {} };
}

const emptyAsks = new Map();
const emptyExits = new Map();

describe('selectLiveSessions — 置顶排序与实时过滤', () => {
  it('按 pinnedAt DESC、lastEventAt DESC、id ASC 排序', () => {
    const sessions = new Map([
      ['plain-new', makeSession({ id: 'plain-new', lastEventAt: 900 })],
      ['pinned-old', makeSession({ id: 'pinned-old', pinnedAt: 100, lastEventAt: 1 })],
      ['pinned-new', makeSession({ id: 'pinned-new', pinnedAt: 200, lastEventAt: 0 })],
      ['tie-b', makeSession({ id: 'tie-b', lastEventAt: 500 })],
      ['tie-a', makeSession({ id: 'tie-a', lastEventAt: 500 })],
    ]);

    expect(selectLiveSessions(sessions).map((session) => session.id)).toEqual([
      'pinned-new',
      'pinned-old',
      'plain-new',
      'tie-a',
      'tie-b',
    ]);
  });

  it('保留未归档 active/dormant 过滤，且不改变输入 Map 的迭代顺序', () => {
    const sessions = new Map([
      ['active', makeSession({ id: 'active', lifecycle: 'active', lastEventAt: 1 })],
      ['dormant', makeSession({ id: 'dormant', lifecycle: 'dormant', pinnedAt: 2 })],
      ['closed', makeSession({ id: 'closed', lifecycle: 'closed', pinnedAt: 3 })],
      ['archived', makeSession({ id: 'archived', archivedAt: 4, pinnedAt: 4 })],
    ]);

    expect(selectLiveSessions(sessions).map((session) => session.id)).toEqual([
      'dormant',
      'active',
    ]);
    expect([...sessions.keys()]).toEqual(['active', 'dormant', 'closed', 'archived']);
  });
});

describe('selectPendingBuckets — archivedAt / lifecycle 过滤（PendingSection 复用口径）', () => {
  it('active + 未归档 + 有 pending → 收入', () => {
    const sessions = new Map([['s1', makeSession({ id: 's1', lifecycle: 'active' })]]);
    const perms = new Map([['s1', [perm('r1')]]]);
    const out = selectPendingBuckets(sessions, perms, emptyAsks, emptyExits);
    expect(out.map((b) => b.session.id)).toEqual(['s1']);
    expect(out[0].total).toBe(1);
  });

  it('archived（archivedAt !== null）→ 即便有 pending 也排除', () => {
    const sessions = new Map([['s1', makeSession({ id: 's1', archivedAt: 123 })]]);
    const perms = new Map([['s1', [perm('r1')]]]);
    expect(selectPendingBuckets(sessions, perms, emptyAsks, emptyExits)).toEqual([]);
  });

  it('lifecycle=closed → 即便有 pending 也排除', () => {
    const sessions = new Map([['s1', makeSession({ id: 's1', lifecycle: 'closed' })]]);
    const perms = new Map([['s1', [perm('r1')]]]);
    expect(selectPendingBuckets(sessions, perms, emptyAsks, emptyExits)).toEqual([]);
  });

  it('dormant + 有 pending → 收入（dormant 仍算实时面板口径）', () => {
    const sessions = new Map([['s1', makeSession({ id: 's1', lifecycle: 'dormant' })]]);
    const perms = new Map([['s1', [perm('r1')]]]);
    expect(selectPendingBuckets(sessions, perms, emptyAsks, emptyExits).map((b) => b.session.id)).toEqual(['s1']);
  });

  it('pending Map 有 key 但 session 不在 sessions Map（已 removeSession）→ 跳过不崩', () => {
    const sessions = new Map<string, SessionRecord>();
    const perms = new Map([['ghost', [perm('r1')]]]);
    expect(selectPendingBuckets(sessions, perms, emptyAsks, emptyExits)).toEqual([]);
  });

  it('total=0（pending Map 空数组）→ 排除', () => {
    const sessions = new Map([['s1', makeSession({ id: 's1' })]]);
    const perms = new Map([['s1', []]]);
    expect(selectPendingBuckets(sessions, perms, emptyAsks, emptyExits)).toEqual([]);
  });

  it('排序：waiting 优先，其次 lastEventAt DESC', () => {
    const sessions = new Map([
      ['a', makeSession({ id: 'a', activity: 'idle', lastEventAt: 100 })],
      ['b', makeSession({ id: 'b', activity: 'waiting', lastEventAt: 50 })],
      ['c', makeSession({ id: 'c', activity: 'idle', lastEventAt: 200 })],
    ]);
    const perms = new Map([
      ['a', [perm('ra')]],
      ['b', [perm('rb')]],
      ['c', [perm('rc')]],
    ]);
    const out = selectPendingBuckets(sessions, perms, emptyAsks, emptyExits);
    // b waiting 最前；a/c 按 lastEventAt DESC → c(200) > a(100)
    expect(out.map((x) => x.session.id)).toEqual(['b', 'c', 'a']);
  });
});
