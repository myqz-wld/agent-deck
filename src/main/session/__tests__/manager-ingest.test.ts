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
  makeAgentDeckTeamRepoMock,
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
// REVIEW_31 Bug 5：见 manager-public-api.test.ts 同源注释
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock(),
  TeamInvariantError: class extends Error {},
}));

// shutdown race guard（issue shutdown-race-ingest-db-guard）: mock @main/store/db 让本文件可切
// isDbClosed() 返回值,验 ingest 入口 closeDb 后短路丢弃尾包。默认 closed=false → 现存 14 个 it 全部
// 走原路径(guard no-op);guard 专测 it 内 __setClosed(true) 再 ingest 验短路。getDb mock 成 throw
// 是防御性兜底(模拟 dbInstance=null 退出态)—— guard 生效时根本不该走到 getDb;位置回归靠 guard 专测
// spy sessionRepo.findByCliSessionId 断言(不是断言 getDb,因 mock 的 findByCliSessionId 纯内存不路由
// getDb,断言 getDb 会 vacuous — reviewer MED-1 修法)。
const dbMock = vi.hoisted(() => {
  let closed = false;
  return {
    isDbClosed: (): boolean => closed,
    __setClosed: (v: boolean): void => {
      closed = v;
    },
    getDb: vi.fn(() => {
      throw new Error('Database not initialized. Call initDb() first.');
    }),
    initDb: vi.fn(),
    closeDb: vi.fn(() => {
      closed = true;
    }),
  };
});
vi.mock('@main/store/db', () => ({
  isDbClosed: dbMock.isDbClosed,
  getDb: dbMock.getDb,
  initDb: dbMock.initDb,
  closeDb: dbMock.closeDb,
}));

// 注意：mock 必须在 import sessionManager 之前（vi.mock 是 hoist 的，但显式分隔更清楚）
import { sessionManager } from '@main/session/manager';
// shutdown guard 专测拿 mocked sessionRepo 引用 spy findByCliSessionId（ingest 第一处 repo 访问）。
// vi.mock('@main/store/session-repo') 已 hoist,此 import 拿到的就是 makeSessionRepoMock() 产物。
import { sessionRepo } from '@main/store/session-repo';

beforeEach(async () => {
  await resetMocks();
  dbMock.__setClosed(false); // 防 guard 专测把 closed 态泄漏给后续 it
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

  it('SDK 首个 session-start 原子持久化 spawn link，hook 伪造同字段无效', () => {
    sessionManager.claimAsSdk('linked-child');
    sessionManager.ingest(
      makeEvent({
        sessionId: 'linked-child',
        source: 'sdk',
        kind: 'session-start',
        payload: {
          cwd: '/tmp',
          initialSpawnLink: { parentSessionId: 'lead-session', depth: 2 },
        },
      }),
    );
    expect(mockSessions.get('linked-child')).toMatchObject({
      spawnedBy: 'lead-session',
      spawnDepth: 2,
    });
    expect(
      mockEmits.find(
        (entry) =>
          entry.name === 'session-upserted' &&
          (entry.payload as SessionRecord).id === 'linked-child',
      )?.payload,
    ).toMatchObject({ spawnedBy: 'lead-session', spawnDepth: 2 });

    sessionManager.ingest(
      makeEvent({
        sessionId: 'forged-hook-child',
        source: 'hook',
        kind: 'session-start',
        payload: {
          cwd: '/tmp',
          initialSpawnLink: { parentSessionId: 'lead-session', depth: 9 },
        },
      }),
    );
    expect(mockSessions.get('forged-hook-child')).toMatchObject({
      spawnedBy: null,
      spawnDepth: 0,
    });
  });

  it('可信 SDK registration 可补齐同一启动流程先创建的 flat row', () => {
    sessionManager.claimAsSdk('late-linked-child');
    sessionManager.ingest(
      makeEvent({
        sessionId: 'late-linked-child',
        source: 'sdk',
        kind: 'message',
        payload: { role: 'assistant', text: 'provider started' },
      }),
    );
    expect(mockSessions.get('late-linked-child')?.spawnedBy).toBeNull();

    sessionManager.ingest(
      makeEvent({
        sessionId: 'late-linked-child',
        source: 'sdk',
        kind: 'session-start',
        payload: {
          cwd: '/tmp',
          initialSpawnLink: { parentSessionId: 'lead-session', depth: 1 },
        },
      }),
    );
    expect(mockSessions.get('late-linked-child')).toMatchObject({
      spawnedBy: 'lead-session',
      spawnDepth: 1,
    });
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

  it('4b) SDK-derived orphan hook → 不创建外部 cli 会话', () => {
    const hookEv = makeEvent({
      sessionId: 'codex-internal-oneshot',
      source: 'hook',
      hookOrigin: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });

    sessionManager.ingest(hookEv);

    expect(mockSessions.get('codex-internal-oneshot')).toBeUndefined();
    expect(mockEvents).toHaveLength(0);
    expect(mockEmits.some((e) => e.name === 'session-upserted')).toBe(false);
  });

  it('4c) 外部 hook session-end → 会话立即 closed', () => {
    sessionManager.ingest(
      makeEvent({
        sessionId: 'codex-external',
        source: 'hook',
        kind: 'session-start',
        payload: { cwd: '/tmp' },
        ts: 100,
      }),
    );

    sessionManager.ingest(
      makeEvent({
        sessionId: 'codex-external',
        source: 'hook',
        kind: 'session-end',
        payload: { cwd: '/tmp', reason: 'completed' },
        ts: 200,
      }),
    );

    const rec = mockSessions.get('codex-external');
    expect(rec?.source).toBe('cli');
    expect(rec?.lifecycle).toBe('closed');
    expect(rec?.endedAt).toBe(200);
  });

  it('4d) real SDK session-end → pinned 会话落 dormant 并清除 pin', () => {
    sessionManager.ingest(
      makeEvent({
        sessionId: 'sdk-pinned-end',
        source: 'sdk',
        kind: 'session-start',
        payload: { cwd: '/tmp' },
        ts: 100,
      }),
    );
    const active = mockSessions.get('sdk-pinned-end');
    if (active) mockSessions.set('sdk-pinned-end', { ...active, pinnedAt: 150 });

    sessionManager.ingest(
      makeEvent({
        sessionId: 'sdk-pinned-end',
        source: 'sdk',
        kind: 'session-end',
        payload: { cwd: '/tmp', reason: 'completed' },
        ts: 200,
      }),
    );

    expect(mockSessions.get('sdk-pinned-end')).toMatchObject({
      lifecycle: 'dormant',
      lastEventAt: 200,
      pinnedAt: null,
    });
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

  // **REVIEW_49 R3 follow-up HIGH-2 + REVIEW_83 HIGH 回归 test**:closed session 撞迟到 hook event
  // 短路丢弃,不复活 lifecycle / 不更新 lastEventAt / 不 emit session-upserted。
  // 触发链:closeSession → markClosed (manager.ts:349,**不**写 recentlyDeleted 黑名单) →
  // 60s 后 hook 子进程内部 buffer 异步飞回,event.sessionId === appSid 直接 dispatch
  // (绕过 3a findByCliSessionId / 黑名单两道防线) → 旧版 ensure() 无 source 守卫复活 closed → active。
  // **REVIEW_83 修法**:ensure() 复活加 SDK user message 守卫(manager.ts:251),hook 迟到事件不复活;
  // un-skip 本 test (原 it.skip pre-existing fail,REVIEW_83 fix 后转 pass)。
  it('REVIEW_83 HIGH: closed session 收到迟到 hook → ensure resume 守卫不复活', () => {
    // 预置 closed session (模拟 closeSession 已跑过)
    mockSessions.set('CLOSED_SID', {
      id: 'CLOSED_SID',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'closed reviewer',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: 200,
      archivedAt: null,
      permissionMode: null,
    });
    const upsertCountBefore = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'CLOSED_SID',
    ).length;

    // 60s 后迟到 hook event(典型:hook 子进程内部 buffer flush 撞 closeSession 后异步飞回)
    const lateHook = makeEvent({
      sessionId: 'CLOSED_SID',
      source: 'hook',
      kind: 'message',
      payload: { text: 'late hook flushed after close' },
      ts: 5000,
    });
    sessionManager.ingest(lateHook);

    // **关键断言**: lifecycle 仍 closed (没复活)
    expect(mockSessions.get('CLOSED_SID')?.lifecycle).toBe('closed');
    // lastEventAt 未推进(advanceState 整段 short-circuit 不调 setActivity)
    expect(mockSessions.get('CLOSED_SID')?.lastEventAt).toBe(100);
    // 没有新 session-upserted emit (UI 不会看到「reviewer 又活了」假活)
    const upsertCountAfter = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'CLOSED_SID',
    ).length;
    expect(upsertCountAfter).toBe(upsertCountBefore);
    // events / file_changes 子表保留供审计 (advanceState 之前的 persistEventRow 仍跑)
    expect(mockEvents.length).toBeGreaterThan(0);
  });

  it('shutdown_session follow-up: closed session 收到迟到 SDK session-end → 不复活', () => {
    mockSessions.set('CLOSED_SDK_TAIL', {
      id: 'CLOSED_SDK_TAIL',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'closed sdk tail',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: 200,
      archivedAt: null,
      permissionMode: null,
    });
    const upsertCountBefore = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'CLOSED_SDK_TAIL',
    ).length;

    sessionManager.ingest(
      makeEvent({
        sessionId: 'CLOSED_SDK_TAIL',
        source: 'sdk',
        kind: 'session-end',
        payload: { reason: 'late tail after shutdown_session' },
        ts: 6000,
      }),
    );

    expect(mockSessions.get('CLOSED_SDK_TAIL')?.lifecycle).toBe('closed');
    expect(mockSessions.get('CLOSED_SDK_TAIL')?.lastEventAt).toBe(100);
    const upsertCountAfter = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'CLOSED_SDK_TAIL',
    ).length;
    expect(upsertCountAfter).toBe(upsertCountBefore);
    expect(mockEvents.length).toBeGreaterThan(0);
  });

  it('shutdown_session follow-up: closed session 收到迟到 SDK assistant message → 不复活', () => {
    mockSessions.set('CLOSED_SDK_ASSISTANT', {
      id: 'CLOSED_SDK_ASSISTANT',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'closed sdk assistant tail',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: 200,
      archivedAt: null,
      permissionMode: null,
    });

    sessionManager.ingest(
      makeEvent({
        sessionId: 'CLOSED_SDK_ASSISTANT',
        source: 'sdk',
        kind: 'message',
        payload: { text: 'late assistant tail after close', role: 'assistant' },
        ts: 7000,
      }),
    );

    expect(mockSessions.get('CLOSED_SDK_ASSISTANT')?.lifecycle).toBe('closed');
    expect(mockSessions.get('CLOSED_SDK_ASSISTANT')?.lastEventAt).toBe(100);
  });

  // **REVIEW_83 HIGH 回归 test (正路径)**:closed session 收到 SDK user message(用户 resume)
  // 仍正常复活 active —— 证复活守卫只放行用户 resume,不误伤 legit resume
  // (recover-and-send-impl.ts:154 emit source:'sdk' user message 触发复活的主路径)。
  it('REVIEW_83 HIGH: closed session 收到 SDK user message(resume) → 正常复活 active', () => {
    mockSessions.set('CLOSED_RESUME', {
      id: 'CLOSED_RESUME',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'closed resume',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: 200,
      archivedAt: null,
      permissionMode: null,
    });
    // SDK 通道事件(用户从 detail 主动 sendMessage → recoverAndSend emit source:'sdk' user message)
    const resumeEvent = makeEvent({
      sessionId: 'CLOSED_RESUME',
      source: 'sdk',
      kind: 'message',
      payload: { text: 'user resume closed session', role: 'user' },
      ts: 6000,
    });
    sessionManager.ingest(resumeEvent);

    // **关键断言**: SDK resume 仍能复活 closed → active(否则破坏 resume 主路径)
    expect(mockSessions.get('CLOSED_RESUME')?.lifecycle).toBe('active');
  });

  it('recentlyDeleted close path：SDK user message 可续聊并清黑名单', () => {
    mockSessions.set('HANDOFF_SOURCE_CONTINUE', {
      id: 'HANDOFF_SOURCE_CONTINUE',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'handoff source',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
      cliSessionId: 'HANDOFF_SOURCE_CLI',
    });
    sessionManager.markClosed('HANDOFF_SOURCE_CONTINUE');
    sessionManager.markRecentlyDeleted('HANDOFF_SOURCE_CONTINUE');

    sessionManager.ingest(
      makeEvent({
        sessionId: 'HANDOFF_SOURCE_CONTINUE',
        source: 'sdk',
        kind: 'message',
        payload: { text: '继续原会话', role: 'user' },
        ts: 8000,
      }),
    );

    expect(mockSessions.get('HANDOFF_SOURCE_CONTINUE')?.lifecycle).toBe('active');
    expect(mockEvents).toHaveLength(1);
    expect(mockEvents[0]?.sessionId).toBe('HANDOFF_SOURCE_CONTINUE');
    expect(mockEvents[0]?.payload).toMatchObject({ text: '继续原会话', role: 'user' });

    sessionManager.ingest(
      makeEvent({
        // 用 cliSessionId 模拟后续 SDK/CLI 维度事件；修法必须同步清 appSid + cliSid 黑名单。
        sessionId: 'HANDOFF_SOURCE_CLI',
        source: 'sdk',
        kind: 'message',
        payload: { text: 'assistant visible too', role: 'assistant' },
        ts: 8001,
      }),
    );

    expect(mockEvents).toHaveLength(2);
    expect(mockEvents[1]?.sessionId).toBe('HANDOFF_SOURCE_CONTINUE');
    expect(mockEvents[1]?.payload).toMatchObject({ text: 'assistant visible too', role: 'assistant' });
  });

  it('recentlyDeleted close path：无用户续聊的迟到 assistant 尾包仍被丢弃', () => {
    mockSessions.set('HANDOFF_SOURCE_TAIL', {
      id: 'HANDOFF_SOURCE_TAIL',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'handoff source tail',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });
    sessionManager.markClosed('HANDOFF_SOURCE_TAIL');
    sessionManager.markRecentlyDeleted('HANDOFF_SOURCE_TAIL');

    sessionManager.ingest(
      makeEvent({
        sessionId: 'HANDOFF_SOURCE_TAIL',
        source: 'sdk',
        kind: 'message',
        payload: { text: 'late assistant after handoff', role: 'assistant' },
        ts: 8100,
      }),
    );

    expect(mockSessions.get('HANDOFF_SOURCE_TAIL')?.lifecycle).toBe('closed');
    expect(mockEvents).toHaveLength(0);
  });

  it('hand_off_session caller closed 但未 recentlyDeleted：后续 assistant 尾包可展示且不复活', () => {
    mockSessions.set('HANDOFF_SOURCE_VISIBLE_TAIL', {
      id: 'HANDOFF_SOURCE_VISIBLE_TAIL',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'handoff source visible tail',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });
    sessionManager.markClosed('HANDOFF_SOURCE_VISIBLE_TAIL');

    sessionManager.ingest(
      makeEvent({
        sessionId: 'HANDOFF_SOURCE_VISIBLE_TAIL',
        source: 'sdk',
        kind: 'message',
        payload: { text: 'handoff tail is visible', role: 'assistant' },
        ts: 8200,
      }),
    );

    expect(mockEvents).toHaveLength(1);
    expect(mockEvents[0]?.payload).toMatchObject({
      text: 'handoff tail is visible',
      role: 'assistant',
    });
    expect(mockSessions.get('HANDOFF_SOURCE_VISIBLE_TAIL')?.lifecycle).toBe('closed');
    expect(mockSessions.get('HANDOFF_SOURCE_VISIBLE_TAIL')?.lastEventAt).toBe(100);
  });

  // **REVIEW_83 HIGH 同源子问题回归 test (reviewer-claude)**:closed + archived 双态 session
  // 收到 SDK 事件也不复活 lifecycle(archivedAt === null 守卫)—— 归档与 lifecycle 正交,
  // 事件流不应偷改归档会话 lifecycle(auto-unarchive 是 unarchiveOnUserSend 显式职责)。
  it('REVIEW_83 HIGH: closed+archived session 收到 SDK 事件 → 不复活(正交守卫)', () => {
    mockSessions.set('CLOSED_ARCH', {
      id: 'CLOSED_ARCH',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'closed archived',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: 200,
      archivedAt: 4000, // 关键:既 closed 又 archived
      permissionMode: null,
    });
    const evt = makeEvent({
      sessionId: 'CLOSED_ARCH',
      source: 'sdk',
      kind: 'message',
      payload: { text: 'event for closed+archived', role: 'user' },
      ts: 7000,
    });
    sessionManager.ingest(evt);

    // **关键断言**: lifecycle 仍 closed(archivedAt 守卫挡住,事件流不偷改归档会话状态)
    expect(mockSessions.get('CLOSED_ARCH')?.lifecycle).toBe('closed');
    expect(mockSessions.get('CLOSED_ARCH')?.archivedAt).toBe(4000);
  });

  it('REVIEW_49 R3 follow-up: archived session 收到迟到 event → advanceState short-circuit', () => {
    // 预置 archived session(用户手动归档,lifecycle 仍 active 但 archivedAt 非 null)
    mockSessions.set('ARCHIVED_SID', {
      id: 'ARCHIVED_SID',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'archived reviewer',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: 5000, // 关键:archived
      permissionMode: null,
    });
    const upsertCountBefore = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'ARCHIVED_SID',
    ).length;

    // 用户归档后 SDK 仍异步推 message event
    const lateEvent = makeEvent({
      sessionId: 'ARCHIVED_SID',
      source: 'sdk',
      kind: 'message',
      payload: { text: 'after archive' },
      ts: 6000,
    });
    sessionManager.ingest(lateEvent);

    // **关键断言**: archivedAt 不被自动清空 (本来 advanceState 不动 archivedAt 即正交设计)
    expect(mockSessions.get('ARCHIVED_SID')?.archivedAt).toBe(5000);
    // lastEventAt 未推进 (UI 不会看到「归档的还在活动」假活)
    expect(mockSessions.get('ARCHIVED_SID')?.lastEventAt).toBe(100);
    // activity 不变(setActivity 不被调)
    expect(mockSessions.get('ARCHIVED_SID')?.activity).toBe('idle');
    // 没有新 session-upserted emit
    const upsertCountAfter = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' &&
        (e.payload as SessionRecord)?.id === 'ARCHIVED_SID',
    ).length;
    expect(upsertCountAfter).toBe(upsertCountBefore);
  });

  // **REVIEW_83 MED 回归 test (reviewer-codex 单方 + lead 验证)**:archived + active 会话收到
  // session-end → advanceState 仍落 lifecycle 终止转换(不再永停 active),但不 emit。
  // 根因:archiveImpl 只写 archivedAt 不动 lifecycle + scheduler findActive/DormantExpiring
  // 过滤 archived 不衰减 → 原版 archived 一律 short-circuit 让 session-end 漏处理 → unarchive
  // 后幽灵 active。修法:archived 短路新增 session-end 终止例外(active→dormant/closed + endedAt)。
  it('REVIEW_83 MED: archived+active session 收到 SDK session-end → 落 dormant 终态(不 emit)', () => {
    mockSessions.set('ARCH_END_SDK', {
      id: 'ARCH_END_SDK',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'archived active sdk-end',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: 5000, // 关键:archived 但 lifecycle 仍 active
      permissionMode: null,
    });
    const upsertBefore = mockEmits.filter(
      (e) => e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'ARCH_END_SDK',
    ).length;

    // SDK 通道 session-end(query 流终止) → dormant 终态
    sessionManager.ingest(
      makeEvent({
        sessionId: 'ARCH_END_SDK',
        source: 'sdk',
        kind: 'session-end',
        payload: { reason: 'sdk-stream-ended' },
        ts: 6000,
      }),
    );

    // **关键断言**: lifecycle 落 dormant(不再永停 active 幽灵),archivedAt 不动(正交保留)
    expect(mockSessions.get('ARCH_END_SDK')?.lifecycle).toBe('dormant');
    expect(mockSessions.get('ARCH_END_SDK')?.archivedAt).toBe(5000);
    // 不 emit session-upserted(archived 会话不作实时活动广播;unarchive 时再读 fresh lifecycle)
    const upsertAfter = mockEmits.filter(
      (e) => e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'ARCH_END_SDK',
    ).length;
    expect(upsertAfter).toBe(upsertBefore);
  });

  // **REVIEW_83 MED 回归 test (hook session-end → closed 终态)**:archived + active 会话收到
  // hook 通道 session-end(终端 CLI 真退出) → closed 终态 + endedAt 写入。
  it('REVIEW_83 MED: archived+active session 收到 hook session-end → 落 closed 终态 + endedAt', () => {
    mockSessions.set('ARCH_END_HOOK', {
      id: 'ARCH_END_HOOK',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'archived active hook-end',
      source: 'cli',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: 5000,
      permissionMode: null,
    });

    sessionManager.ingest(
      makeEvent({
        sessionId: 'ARCH_END_HOOK',
        source: 'hook',
        kind: 'session-end',
        payload: {},
        ts: 8000,
      }),
    );

    // **关键断言**: hook session-end → closed 终态 + endedAt = event.ts
    expect(mockSessions.get('ARCH_END_HOOK')?.lifecycle).toBe('closed');
    expect(mockSessions.get('ARCH_END_HOOK')?.endedAt).toBe(8000);
    expect(mockSessions.get('ARCH_END_HOOK')?.archivedAt).toBe(5000);
  });

  it('REVIEW_49 R3 follow-up: dormant session 收到 event → 仍走复活路径(不在 short-circuit 范围)', () => {
    // 预置 dormant session(SDK query 结束但 jsonl 在,user resume 应能复活)
    mockSessions.set('DORMANT_SID', {
      id: 'DORMANT_SID',
      agentId: 'claude-code',
      cwd: '/tmp',
      title: 'dormant',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 0,
      lastEventAt: 100,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    const resumeEvent = makeEvent({
      sessionId: 'DORMANT_SID',
      source: 'sdk',
      kind: 'message',
      payload: { text: 'user resume' },
      ts: 7000,
    });
    sessionManager.ingest(resumeEvent);

    // **关键断言**: dormant 走复活路径 → active(short-circuit 仅 closed/archived)
    expect(mockSessions.get('DORMANT_SID')?.lifecycle).toBe('active');
    expect(mockSessions.get('DORMANT_SID')?.lastEventAt).toBe(7000);
  });
});

describe('SessionManager.ingest shutdown race guard（issue shutdown-race-ingest-db-guard）', () => {
  it('DB 已 closed → ingest 入口短路丢弃尾包（不碰 repo / 不落库 / 不广播）', () => {
    // 模拟 before-quit finally closeDb() 跑过后,adapter in-flight 尾包飞回 ingest。
    dbMock.__setClosed(true);

    // **位置回归哨兵（MED-1 修法,reviewer 双方共识 + claude 实测）**:spy ingest 第一处 repo 访问
    // findByCliSessionId(manager.ts ingest 第一行 guard 之后紧跟的 sessionRepo 调用)。guard 生效时
    // 根本不该到达 → 0 次调用。若 guard 被挪到 findByCliSessionId 之后,本 spy 会被调用 → 抓回归。
    // (旧版断言 dbMock.getDb 是 vacuous:mock 的 findByCliSessionId 纯内存遍历不路由 getDb,挪 guard
    // 也恒 0 次 — reviewer-claude 实测「挪 guard 后 16/16 仍过」证伪旧哨兵,改 spy 真 repo 入口。)
    const findSpy = vi.spyOn(sessionRepo as { findByCliSessionId: (s: string) => unknown }, 'findByCliSessionId');

    const tail = makeEvent({
      sessionId: 'sess-shutdown-tail',
      source: 'sdk',
      kind: 'message',
      payload: { text: 'late tail packet after closeDb' },
      ts: 9000,
    });
    sessionManager.ingest(tail);

    // 入口 isDbClosed() 短路 → 不碰任何 repo / 不建 record / 不落 events / 不 emit
    expect(findSpy).not.toHaveBeenCalled();
    expect(mockSessions.get('sess-shutdown-tail')).toBeUndefined();
    expect(mockEvents).toHaveLength(0);
    expect(mockEmits).toHaveLength(0);

    findSpy.mockRestore();
  });

  it('DB 已 closed → token-usage 尾包也被入口 guard 挡住（不写 token_usage / 不 emit）', () => {
    // token-usage 早返旁路在 ingest guard 之后(manager.ts:331 guard → :370 persistTokenUsage→
    // tokenUsageRepo→getDb)。closed 时入口 guard 必须先短路,否则退出期 token-usage 尾包会
    // persistTokenUsage→getDb throw。锁住 guard 不被挪到 token-usage 早返之后(reviewer-codex 修法建议)。
    dbMock.__setClosed(true);
    const findSpy = vi.spyOn(sessionRepo as { findByCliSessionId: (s: string) => unknown }, 'findByCliSessionId');

    const tokenTail = makeEvent({
      sessionId: 'sess-token-tail',
      source: 'sdk',
      kind: 'token-usage',
      payload: { model: 'claude-opus-4-8', inputTokens: 10, outputTokens: 20 },
      ts: 9100,
    });
    sessionManager.ingest(tokenTail);

    // guard 在 token-usage 早返之前 → 整体短路,token-usage-changed 也不 emit
    expect(findSpy).not.toHaveBeenCalled();
    expect(mockEmits.filter((e) => e.name === 'token-usage-changed')).toHaveLength(0);

    findSpy.mockRestore();
  });

  it('DB 未 closed（正常运行态）→ ingest 走原路径正常落库（guard no-op）', () => {
    // 显式验「未关闭时 guard 不误伤正常事件」—— 与现存 14 个 it 默认态一致,但本 it 紧挨上面
    // closed 专测,验 beforeEach 复位 closed=false 生效 + guard 非误短路 + findByCliSessionId 真被调。
    expect(dbMock.isDbClosed()).toBe(false);
    const findSpy = vi.spyOn(sessionRepo as { findByCliSessionId: (s: string) => unknown }, 'findByCliSessionId');

    const ev = makeEvent({
      sessionId: 'sess-normal-after-guard',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);

    // guard no-op → findByCliSessionId 正常被调（对偶证明:closed 时 0 次 vs 正常时 ≥1 次,
    // 两个 case 合起来才真正锁住「guard 位于 findByCliSessionId 之前」位置不变量）。
    expect(findSpy).toHaveBeenCalled();
    expect(mockSessions.get('sess-normal-after-guard')?.source).toBe('cli');
    expect(mockEvents).toHaveLength(1);

    findSpy.mockRestore();
  });
});
