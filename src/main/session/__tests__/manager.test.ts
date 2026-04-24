/**
 * SessionManager.ingest 五种时序单测（CHANGELOG_20 / Phase 2.2）。
 *
 * 测试 ingest 拆分后五段（dedupOrClaim / ensureRecord / persistEventRow /
 * persistFileChange / advanceState）的关键时序约束 —— 这些都是 CHANGELOG_15/16/REVIEW_1
 * 反复修过的硬约束，重构后必须保持不变。
 *
 * Mock 策略：
 * - sessionRepo / eventRepo / fileChangeRepo：内存 Map / 数组替身（不起 SQLite）
 * - event-bus：emit 收集到数组
 * - realpathSync 在测试环境对 /tmp/xxx 这种真实存在路径正常工作；不存在路径走 catch fallback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

// 模块级 mock 状态（每个 test 在 beforeEach 重置）
const mockSessions = new Map<string, SessionRecord>();
const mockEvents: AgentEvent[] = [];
const mockFileChanges: unknown[] = [];
const mockEmits: { name: string; payload: unknown }[] = [];

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (id: string) => mockSessions.get(id) ?? null,
    upsert: (rec: SessionRecord) => {
      mockSessions.set(rec.id, rec);
    },
    setActivity: (id: string, activity: SessionRecord['activity'], ts: number) => {
      const r = mockSessions.get(id);
      if (r) mockSessions.set(id, { ...r, activity, lastEventAt: ts });
    },
    setLifecycle: (id: string, lifecycle: SessionRecord['lifecycle'], ts: number) => {
      const r = mockSessions.get(id);
      if (r) {
        mockSessions.set(id, {
          ...r,
          lifecycle,
          endedAt: lifecycle === 'closed' ? ts : null,
        });
      }
    },
    setArchived: (id: string, ts: number | null) => {
      const r = mockSessions.get(id);
      if (r) mockSessions.set(id, { ...r, archivedAt: ts });
    },
    setPermissionMode: vi.fn(),
    delete: (id: string) => {
      mockSessions.delete(id);
    },
    listActiveAndDormant: () =>
      [...mockSessions.values()].filter(
        (s) => s.lifecycle !== 'closed' && s.archivedAt === null,
      ),
    listHistory: () => [],
    rename: vi.fn(),
  },
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    insert: (e: AgentEvent) => {
      mockEvents.push(e);
      return mockEvents.length;
    },
    listForSession: () => [],
    countForSession: () => 0,
    findLatestAssistantMessage: () => null,
    deleteForSession: vi.fn(),
    hasToolUseStartWithFilePath: () => false,
  },
}));

vi.mock('@main/store/file-change-repo', () => ({
  fileChangeRepo: {
    insert: (rec: unknown) => {
      mockFileChanges.push(rec);
      return mockFileChanges.length;
    },
    listForSession: () => [],
    countForSession: () => 0,
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: (name: string, payload: unknown) => {
      mockEmits.push({ name, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// 注意：mock 必须在 import sessionManager 之前（vi.mock 是 hoist 的，但显式分隔更清楚）
import { sessionManager, setSessionCloseFn } from '@main/session/manager';

function makeEvent(over: Partial<AgentEvent> & { source?: 'sdk' | 'hook' }): AgentEvent {
  return {
    sessionId: over.sessionId ?? 'sess-default',
    agentId: over.agentId ?? 'claude-code',
    kind: over.kind ?? 'session-start',
    payload: over.payload ?? { cwd: '/tmp' },
    ts: over.ts ?? Date.now(),
    source: over.source,
  } as AgentEvent;
}

beforeEach(() => {
  mockSessions.clear();
  mockEvents.length = 0;
  mockFileChanges.length = 0;
  mockEmits.length = 0;
  // 清 SessionManager 内部状态（sdkOwned + pendingSdkCwds）：
  // 拿到当前 sessions 的 id 列表，逐个 release；pending 走 expectSdkSession 反向不可达，
  // 但每次测试都是独立 cwd 不会互相影响。
  // 安全起见再 release 一遍上次测试可能留下的 sdkOwned。
  for (const id of [
    'sess-1',
    'sess-2',
    'sess-3',
    'sess-hook-first',
    'sess-sdk-claim',
    'sess-after-claim',
    'sess-existing',
  ]) {
    sessionManager.releaseSdkClaim(id);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionManager.ingest 时序', () => {
  it('1) hook 先到（无 sdk claim） → 创建 cli 会话 + 落库 + 广播 session-upserted', () => {
    const ev = makeEvent({
      sessionId: 'sess-hook-first',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);

    const rec = mockSessions.get('sess-hook-first');
    expect(rec).toBeDefined();
    expect(rec!.source).toBe('cli');
    expect(rec!.lifecycle).toBe('active');
    expect(mockEvents).toHaveLength(1);
    // 应至少有一次 session-upserted（创建时） + 一次 agent-event
    const upsertCount = mockEmits.filter((e) => e.name === 'session-upserted').length;
    const agentCount = mockEmits.filter((e) => e.name === 'agent-event').length;
    expect(upsertCount).toBeGreaterThanOrEqual(1);
    expect(agentCount).toBe(1);
  });

  it('2) SDK 先到 + 后续同 id hook → hook 被丢（sdkOwned dedup）', () => {
    sessionManager.claimAsSdk('sess-sdk-claim');
    const sdkEv = makeEvent({
      sessionId: 'sess-sdk-claim',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(sdkEv);
    expect(mockSessions.get('sess-sdk-claim')?.source).toBe('sdk');
    expect(mockEvents).toHaveLength(1);

    // 同 sessionId 的 hook 事件应被丢弃：events 数量不变，emit 不增加 agent-event
    const hookEv = makeEvent({
      sessionId: 'sess-sdk-claim',
      source: 'hook',
      kind: 'message',
      payload: { text: 'should be dropped' },
    });
    const beforeAgent = mockEmits.filter((e) => e.name === 'agent-event').length;
    sessionManager.ingest(hookEv);
    expect(mockEvents).toHaveLength(1); // 不增加
    const afterAgent = mockEmits.filter((e) => e.name === 'agent-event').length;
    expect(afterAgent).toBe(beforeAgent); // agent-event 不增加
  });

  it('3) 同 cwd 多 hook（pendingSdkCwds 兜底）→ 第一条被 claim 丢、第二条创建 cli 会话', () => {
    // SDK 已注册要拉起 /tmp 上的会话，但真实 sessionId 还没到
    const release = sessionManager.expectSdkSession('/tmp');

    // 第一条 hook（新 sessionId）→ claim + 丢
    const hook1 = makeEvent({
      sessionId: 'sess-1',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(hook1);
    expect(mockSessions.get('sess-1')).toBeUndefined(); // 没建 record
    expect(mockEvents).toHaveLength(0); // events 表无数据

    // 第二条 hook（不同 sessionId 同 cwd）→ pending 已被消费，应正常创建 cli 会话
    const hook2 = makeEvent({
      sessionId: 'sess-2',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(hook2);
    expect(mockSessions.get('sess-2')?.source).toBe('cli');
    expect(mockEvents).toHaveLength(1);

    // 释放（即便已消费也安全）
    release();
  });

  it('4) hook 后到（record 已存在但 SDK 接管） → 被丢', () => {
    // 先建 sdk record
    sessionManager.claimAsSdk('sess-existing');
    const sdkEv = makeEvent({
      sessionId: 'sess-existing',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(sdkEv);
    const eventsBefore = mockEvents.length;

    // 同 id hook 后到（即便 record 存在，sdkOwned 优先丢）
    const hookEv = makeEvent({
      sessionId: 'sess-existing',
      source: 'hook',
      kind: 'message',
      payload: { text: 'late hook' },
    });
    sessionManager.ingest(hookEv);
    expect(mockEvents.length).toBe(eventsBefore); // 不增加
  });

  it('5) file-changed 事件 → fileChangeRepo.insert 被调用 + before/after 序列化', () => {
    const ev = makeEvent({
      sessionId: 'sess-3',
      source: 'sdk',
      kind: 'file-changed',
      payload: {
        cwd: '/tmp',
        filePath: '/tmp/foo.txt',
        kind: 'text',
        before: 'hello',
        after: 'hello world',
        toolCallId: 'tu_1',
      },
    });
    sessionManager.ingest(ev);
    expect(mockFileChanges).toHaveLength(1);
    const rec = mockFileChanges[0] as {
      sessionId: string;
      filePath: string;
      kind: string;
      beforeBlob: string | null;
      afterBlob: string | null;
      toolCallId: string | null;
    };
    expect(rec.sessionId).toBe('sess-3');
    expect(rec.filePath).toBe('/tmp/foo.txt');
    expect(rec.beforeBlob).toBe('hello');
    expect(rec.afterBlob).toBe('hello world');
    expect(rec.toolCallId).toBe('tu_1');
  });

  it('额外约束：claim 早退顺序 —— hook 首发被 claim 时绝不调 ensure（不落假 cli 会话）', () => {
    sessionManager.expectSdkSession('/tmp');
    const hook = makeEvent({
      sessionId: 'sess-after-claim',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(hook);
    // 关键断言：record 没创建（不是先创建 cli 再 claim）
    expect(mockSessions.has('sess-after-claim')).toBe(false);
    // 没落 events 表
    expect(mockEvents).toHaveLength(0);
    // 没广播 session-upserted
    expect(mockEmits.filter((e) => e.name === 'session-upserted')).toHaveLength(0);
  });

  it('REVIEW_5 H1：hook 抢先复活 OLD_ID（resume 路径）→ cwd 命中 pendingSdkCwds 即便 record 已存在也 skip+claim', () => {
    // 预置：resume 历史会话已在 DB 里 (closed)，模拟用户从「历史」tab 点开发消息后
    // 触发 createAdapterSession({resume:'OLD_ID'}) 启动 SDK 的场景
    mockSessions.set('OLD_ID', {
      id: 'OLD_ID',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'old',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 0,
      endedAt: 0,
      archivedAt: null,
      permissionMode: null,
    });
    // SDK 注册要拉起 /tmp 的会话（sdk-bridge.expectSdkSession 调用）
    sessionManager.expectSdkSession('/tmp');
    // CLI 子进程的 SessionStart hook 抢先到达，session_id 就是历史 OLD_ID
    // 旧实现：dedupOrClaim 第二条 `!sessionRepo.get(id)` 守卫失效 → hook 通过 →
    //         ensure(OLD_ID, source:'cli') → existing closed → revive → 出现一条 cli active；
    //         配合 SDK 30s fallback 造的 tempKey active → 用户看到「两条 active」
    const hook = makeEvent({
      sessionId: 'OLD_ID',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(hook);

    // 关键断言：H1 新分支拦下 → record 仍是 closed 没被复活
    expect(mockSessions.get('OLD_ID')?.lifecycle).toBe('closed');
    expect(mockSessions.get('OLD_ID')?.source).toBe('sdk'); // source 也没被改成 cli
    // hook 事件没落 events 表
    expect(mockEvents).toHaveLength(0);
    // 没广播多余的 session-upserted（claim 只是内部 sdkOwned set，不动 DB）
    expect(
      mockEmits.filter(
        (e) =>
          e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'OLD_ID',
      ),
    ).toHaveLength(0);

    // 后续同 id 的 hook 事件继续被 dedup（已 claim）
    const hookLate = makeEvent({
      sessionId: 'OLD_ID',
      source: 'hook',
      kind: 'message',
      payload: { text: 'should also be dropped' },
    });
    sessionManager.ingest(hookLate);
    expect(mockEvents).toHaveLength(0);

    // 清理：让其他测试不被这条 sdkOwned 污染
    sessionManager.releaseSdkClaim('OLD_ID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW_4 L8 + H1 回归补测：公共 API 主路径 + 「删除后尾包不复活幽灵」
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager 公共 API 主路径（REVIEW_4 L8）', () => {
  it('archive() → 标 archivedAt + 广播 upserted；list() 不再返回该 session', () => {
    // 预置一个 active session
    const ev = makeEvent({
      sessionId: 'sess-archive',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    expect(sessionManager.list().some((s) => s.id === 'sess-archive')).toBe(true);

    sessionManager.archive('sess-archive');
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

  it('unarchive() → 清 archivedAt 且不动 lifecycle（CLAUDE.md「正交」约定）', () => {
    const ev = makeEvent({
      sessionId: 'sess-unarchive',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    sessionManager.archive('sess-unarchive');
    const archived = mockSessions.get('sess-unarchive');
    const lifecycleBefore = archived?.lifecycle;

    sessionManager.unarchive('sess-unarchive');
    const r = mockSessions.get('sess-unarchive');
    expect(r?.archivedAt).toBeNull();
    expect(r?.lifecycle).toBe(lifecycleBefore); // 不被改动
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
});

describe('SessionManager.delete + H1 删除后尾包不复活幽灵（REVIEW_4 H1）', () => {
  let closeCalls: string[] = [];

  beforeEach(() => {
    closeCalls = [];
    setSessionCloseFn(async (_agentId, sid) => {
      closeCalls.push(sid);
    });
  });

  afterEach(() => {
    setSessionCloseFn(null);
  });

  it('delete() await close 完成 + 删 DB 行 + 广播 session-removed', async () => {
    const ev = makeEvent({
      sessionId: 'sess-del-1',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    expect(mockSessions.has('sess-del-1')).toBe(true);

    await sessionManager.delete('sess-del-1');

    expect(closeCalls).toContain('sess-del-1');
    expect(mockSessions.has('sess-del-1')).toBe(false);
    expect(mockEmits.some((e) => e.name === 'session-removed' && e.payload === 'sess-del-1')).toBe(
      true,
    );
  });

  it('删除窗口内（60s）尾包 finished:interrupted 被丢弃，不创建幽灵 record', async () => {
    const ev = makeEvent({
      sessionId: 'sess-ghost',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    await sessionManager.delete('sess-ghost');
    expect(mockSessions.has('sess-ghost')).toBe(false);

    // 在 tail ingest 之前 snapshot：之前 ingest 创建 record + delete 都会 emit，
    // 黑名单要保证「**这一次** ingest 之后不再出现新增 upserted/agent-event」。
    const eventsBefore = mockEvents.length;
    const upsertBefore = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'sess-ghost',
    ).length;
    const agentEventBefore = mockEmits.filter((e) => e.name === 'agent-event').length;

    // 模拟 SDK 流终止时的尾包：closeSession abort 后 catch 路径如果**没有** intentionallyClosed
    // 屏蔽，会走到这里——manager 黑名单兜底必须丢弃。
    const tailFinished = makeEvent({
      sessionId: 'sess-ghost',
      source: 'sdk',
      kind: 'finished',
      payload: { ok: false, subtype: 'interrupted' },
    });
    sessionManager.ingest(tailFinished);

    // 关键断言：DB 行没复活、events 表没新增、广播总数没增加（黑名单在 ingest 入口拦下）
    expect(mockSessions.has('sess-ghost')).toBe(false);
    expect(mockEvents.length).toBe(eventsBefore);
    expect(
      mockEmits.filter(
        (e) =>
          e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'sess-ghost',
      ).length,
    ).toBe(upsertBefore);
    expect(mockEmits.filter((e) => e.name === 'agent-event').length).toBe(agentEventBefore);
  });

  it('删除窗口内任意 source 尾包都丢弃（防 hook 通道也复活）', async () => {
    const ev = makeEvent({
      sessionId: 'sess-ghost-hook',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    await sessionManager.delete('sess-ghost-hook');

    const eventsBefore = mockEvents.length;
    const lateHook = makeEvent({
      sessionId: 'sess-ghost-hook',
      source: 'hook',
      kind: 'message',
      payload: { text: 'late hook tail' },
    });
    sessionManager.ingest(lateHook);

    expect(mockSessions.has('sess-ghost-hook')).toBe(false);
    expect(mockEvents.length).toBe(eventsBefore);
  });
});
