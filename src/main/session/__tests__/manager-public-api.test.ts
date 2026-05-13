/**
 * SessionManager 公共 API 主路径单测（REVIEW_4 L8 + REVIEW_7 M3）。
 *
 * 拆分自 manager.test.ts (CHANGELOG_52 Step 1)。本文件保留原 public API describe 内的 4 个 it。
 * 共享 mock setup 见 manager-test-setup.ts；vi.mock 调用必须在本文件顶部（hoist 约束）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import {
  makeAgentDeckTeamRepoMock,
  makeEvent,
  makeEventBusMock,
  makeEventRepoMock,
  makeFileChangeRepoMock,
  makeSessionRepoMock,
  mockEmits,
  mockSessions,
  resetMocks,
} from './manager-test-setup';

vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock() }));
vi.mock('@main/store/event-repo', () => ({ eventRepo: makeEventRepoMock() }));
vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: makeFileChangeRepoMock() }));
vi.mock('@main/event-bus', () => ({ eventBus: makeEventBusMock() }));
// REVIEW_31 Bug 5：sessionManager.list/delete/markClosed 调真 agent-deck-team-repo →
// 真 getDb() throws「Database not initialized」。无 team 联动 mock 让主路径走通。
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock(),
  TeamInvariantError: class extends Error {},
}));

import { sessionManager } from '@main/session/manager';

beforeEach(async () => {
  await resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionManager 公共 API 主路径（REVIEW_4 L8）', () => {
  it('archive() → 标 archivedAt + 广播 upserted；list() 不再返回该 session', async () => {
    // 预置一个 active session
    const ev = makeEvent({
      sessionId: 'sess-archive',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    expect(sessionManager.list().some((s) => s.id === 'sess-archive')).toBe(true);

    await sessionManager.archive('sess-archive');
    const r = mockSessions.get('sess-archive');
    expect(r?.archivedAt).not.toBeNull();
    expect(sessionManager.list().some((s) => s.id === 'sess-archive')).toBe(false);
    // 广播了 session-upserted
    expect(
      mockEmits.some(
        (e) =>
          e.name === 'session-upserted' &&
          (e.payload as SessionRecord)?.id === 'sess-archive' &&
          (e.payload as SessionRecord)?.archivedAt !== null,
      ),
    ).toBe(true);
  });

  it('unarchive() → 清 archivedAt 且不动 lifecycle（CLAUDE.md「正交」约定）', async () => {
    const ev = makeEvent({
      sessionId: 'sess-unarchive',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    await sessionManager.archive('sess-unarchive');
    const archived = mockSessions.get('sess-unarchive');
    const lifecycleBefore = archived?.lifecycle;

    await sessionManager.unarchive('sess-unarchive');
    const r = mockSessions.get('sess-unarchive');
    expect(r?.archivedAt).toBeNull();
    expect(r?.lifecycle).toBe(lifecycleBefore); // 不被改动
  });

  it('unarchiveOnUserSend() → dormant + archived → 清 archivedAt + lifecycle 仍 dormant + emit upsert（plan mcp-bug-and-feature-batch-20260513 N bug fix）', async () => {
    // 预置 dormant + archived 会话（最常见的「历史归档」状态）
    mockSessions.set('sess-user-send', {
      id: 'sess-user-send',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 0,
      endedAt: null,
      archivedAt: 1234567890,
      permissionMode: null,
    });
    const emitsBefore = mockEmits.length;

    await sessionManager.unarchiveOnUserSend('sess-user-send');

    const r = mockSessions.get('sess-user-send');
    expect(r?.archivedAt).toBeNull();
    expect(r?.lifecycle).toBe('dormant'); // 与 unarchive 同款约定：lifecycle 不动
    // emit session-upserted 触发（让 renderer 立即看到归档徽章消失 / 移到实时面板）
    expect(
      mockEmits.slice(emitsBefore).some(
        (e) =>
          e.name === 'session-upserted' &&
          (e.payload as SessionRecord)?.id === 'sess-user-send' &&
          (e.payload as SessionRecord)?.archivedAt === null,
      ),
    ).toBe(true);
  });

  it('unarchiveOnUserSend() → 未 archived → noop（不调 unarchive / 不 emit / lifecycle 不动）', async () => {
    // 预置 active + 未 archived 会话（用户对一条实时会话也调 sendMessage 是常见场景）
    mockSessions.set('sess-active-send', {
      id: 'sess-active-send',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 't',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 0,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });
    const emitsBefore = mockEmits.length;

    await sessionManager.unarchiveOnUserSend('sess-active-send');

    const r = mockSessions.get('sess-active-send');
    expect(r?.archivedAt).toBeNull();
    expect(r?.lifecycle).toBe('active');
    // 未 archived guard 早返：不该 emit 任何 session-upserted（避免 renderer 不必要刷新 +
    // team-coordinator 多余 unarchiveTeamsForRevivedLead 跑）
    expect(
      mockEmits.slice(emitsBefore).filter((e) => e.name === 'session-upserted').length,
    ).toBe(0);
  });

  it('unarchiveOnUserSend() → 不存在的 sid → noop（caller 自己处理 not-found）', async () => {
    const emitsBefore = mockEmits.length;
    await sessionManager.unarchiveOnUserSend('sess-non-existent');
    expect(mockEmits.slice(emitsBefore).length).toBe(0);
  });

  it('reactivate() → closed → active', () => {
    const ev = makeEvent({
      sessionId: 'sess-reactivate',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    // 手动设为 closed
    const r = mockSessions.get('sess-reactivate');
    if (r) mockSessions.set('sess-reactivate', { ...r, lifecycle: 'closed' });

    sessionManager.reactivate('sess-reactivate');
    expect(mockSessions.get('sess-reactivate')?.lifecycle).toBe('active');
  });

  it('renameSdkSession() → 原子转移 sdkOwned claim（REVIEW_7 M3：内聚 release+claim）', async () => {
    const { sessionRepo } = await import('@main/store/session-repo');
    // 让 mock 的 sessionRepo.rename 实际改 mockSessions，便于断言后 get(toId) 拿到 record
    vi.mocked(sessionRepo.rename).mockImplementation((from: string, to: string) => {
      const r = mockSessions.get(from);
      if (r) {
        mockSessions.delete(from);
        mockSessions.set(to, { ...r, id: to });
      }
    });

    // OLD_ID 已被 SDK claim + 有 sessions record
    sessionManager.claimAsSdk('OLD_ID');
    mockSessions.set('OLD_ID', {
      id: 'OLD_ID',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 't',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 0,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    sessionManager.renameSdkSession('OLD_ID', 'NEW_ID');

    // 关键断言：sdkOwned claim 已从 OLD_ID 原子转移到 NEW_ID（M3 修复点）
    // H5 follow-up Phase 3: `#sdkOwned` 真私有，反射 cast 已封死，统一走公开 hasSdkClaim API。
    expect(sessionManager.hasSdkClaim('OLD_ID')).toBe(false);
    expect(sessionManager.hasSdkClaim('NEW_ID')).toBe(true);

    // sessionRepo.rename 被调用
    expect(vi.mocked(sessionRepo.rename)).toHaveBeenCalledWith('OLD_ID', 'NEW_ID');
    // session-renamed + session-upserted 都广播了
    expect(
      mockEmits.some(
        (e) =>
          e.name === 'session-renamed' &&
          (e.payload as { from: string; to: string }).from === 'OLD_ID' &&
          (e.payload as { from: string; to: string }).to === 'NEW_ID',
      ),
    ).toBe(true);
    expect(
      mockEmits.some(
        (e) => e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'NEW_ID',
      ),
    ).toBe(true);

    // 清理：避免污染下一个测试
    sessionManager.releaseSdkClaim('NEW_ID');
  });
});
