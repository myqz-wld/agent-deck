/**
 * SessionManager.ingest 时序单测（CHANGELOG_20 / Phase 2.2 + REVIEW_5 H1）。
 *
 * 拆分自 manager.test.ts (CHANGELOG_52 Step 1)。本文件保留原 ingest describe 内的 7 个 it。
 * 共享 mock setup 见 manager-test-setup.ts；vi.mock 调用必须在本文件顶部（hoist 约束）。
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
import type { SessionRecord } from '@shared/types';
import {
  makeEvent,
  makeEventBusMock,
  makeEventRepoMock,
  makeFileChangeRepoMock,
  makeSessionRepoMock,
  mockEmits,
  mockEvents,
  mockFileChanges,
  mockSessions,
  resetMocks,
} from './manager-test-setup';

vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock() }));
vi.mock('@main/store/event-repo', () => ({ eventRepo: makeEventRepoMock() }));
vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: makeFileChangeRepoMock() }));
vi.mock('@main/event-bus', () => ({ eventBus: makeEventBusMock() }));

// 注意：mock 必须在 import sessionManager 之前（vi.mock 是 hoist 的，但显式分隔更清楚）
import { sessionManager } from '@main/session/manager';

beforeEach(async () => {
  await resetMocks();
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
