import { describe, expect, it, vi } from 'vitest';
import type { InternalSession } from '../sdk-bridge/types';
import {
  emits,
  makeBridge,
  makeFakeThread,
  makeInternalSession,
  sessionManager,
} from './consume-fork-fixture';
describe('codex ThreadLoop.runTurnLoop thread.started 三态（symmetry-plan P2 MED-D）', () => {
  it('case 1 (新建路径): !threadId → 设 internal.threadId + claimAsSdk + firstIdCb(NEW_ID)', async () => {
    const bridge = makeBridge();
    const thread = makeFakeThread([
      { type: 'thread.started', thread_id: 'NEW_ID', runtimeIdentity: null },
    ]);
    const internal = makeInternalSession(thread, null); // threadId = null = 新建路径
    const tempKey = 'temp-uuid';
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set(tempKey, internal);

    const firstIdCb = vi.fn();
    const earlyErrCb = vi.fn();
    const threadLoop = (bridge as unknown as { threadLoop: { runTurnLoop: typeof bridge['sendMessage'] } }).threadLoop as unknown as {
      runTurnLoop: (
        i: InternalSession,
        k: string,
        firstIdCb?: (id: string) => void,
        earlyErrCb?: (msg: string) => void,
      ) => Promise<void>;
    };
    await threadLoop.runTurnLoop(internal, tempKey, firstIdCb, earlyErrCb);

    // case 1 行为：firstIdCb 收 NEW_ID + internal.threadId 设为 NEW_ID
    expect(firstIdCb).toHaveBeenCalledWith('NEW_ID');
    expect(internal.threadId).toBe('NEW_ID');
    // earlyErrCb 不应被调（成功路径）
    expect(earlyErrCb).not.toHaveBeenCalled();
    // case 1 不调 renameSdkSession（rename 在 startNewThreadAndAwaitId 外层做,本 method 不管）
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
  });

  it('case 2 (恢复路径,id 一致): threadId === ev.thread_id → 仅 firstIdCb 不 rename', async () => {
    const bridge = makeBridge();
    const SAME_ID = 'same-id';
    const thread = makeFakeThread([
      { type: 'thread.started', thread_id: SAME_ID, runtimeIdentity: null },
    ]);
    const internal = makeInternalSession(thread, SAME_ID); // threadId 已设(resume path)
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set(SAME_ID, internal);

    const firstIdCb = vi.fn();
    const threadLoop = (bridge as unknown as { threadLoop: { runTurnLoop: unknown } }).threadLoop as {
      runTurnLoop: (
        i: InternalSession,
        k: string,
        firstIdCb?: (id: string) => void,
      ) => Promise<void>;
    };
    await threadLoop.runTurnLoop(internal, SAME_ID, firstIdCb);

    // case 2 行为: firstIdCb 收 same id
    expect(firstIdCb).toHaveBeenCalledWith(SAME_ID);
    // 不 rename(id 一致没必要切 Map key)
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
    // sessions Map 仍持 SAME_ID
    expect(sessionsMap.has(SAME_ID)).toBe(true);
  });

  it('case 3 (恢复路径,id 不同 — 反向 rename 后不动 sessions Map,只 update cli_session_id 列): SDK 返不同 thread_id → sessions Map key 不变 + sessionManager.updateCliSessionId(applicationSid, NEW_ID)', async () => {
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6 反向 rename 修订**:
    // case 3 fork detect 不再切 sessions Map key (sessions.id 不变);
    // applicationSid 维度: sessions Map key = applicationSid (S3 ctor + S6 fork detect 后冻结);
    // cli sid 维度: 走 sessionManager.updateCliSessionId(applicationSid, NEW_ID) 单列 UPDATE +
    // OLD_CLI_ID 进 recentlyDeleted 黑名单 60s (R5 HIGH-R5-1 + R6 MED-R6-1 修订)。
    const bridge = makeBridge();
    const OLD_ID = 'old-resume-id';
    const NEW_ID = 'new-fork-id';
    // 模拟 SDK resumeThread 返回的 thread 在 thread.started 事件里给出新 id（罕见 + future-proof）
    const thread = makeFakeThread([
      { type: 'thread.started', thread_id: NEW_ID, runtimeIdentity: null },
    ]);
    const internal = makeInternalSession(thread, OLD_ID); // resume path: threadId 已设
    // 反向 rename 后 sessions Map key = applicationSid (= OLD_ID for resume path); cli sid 维度 internal.threadId
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set(internal.applicationSid, internal);

    const firstIdCb = vi.fn();
    const threadLoop = (bridge as unknown as { threadLoop: { runTurnLoop: unknown } }).threadLoop as {
      runTurnLoop: (
        i: InternalSession,
        k: string,
        firstIdCb?: (id: string) => void,
      ) => Promise<void>;
    };
    await threadLoop.runTurnLoop(internal, OLD_ID, firstIdCb);

    // case 3 关键行为(反向 rename 修订):
    // 1. firstIdCb 收 NEW_ID（不是 OLD_ID）
    expect(firstIdCb).toHaveBeenCalledWith(NEW_ID);
    // 2. internal.threadId 切到 NEW_ID (cli sid 维度 update)
    expect(internal.threadId).toBe(NEW_ID);
    // 3. sessions Map key 不变 (applicationSid 维度): OLD_ID 不删,NEW_ID 不 set
    expect(sessionsMap.has(internal.applicationSid)).toBe(true);
    expect(sessionsMap.get(internal.applicationSid)).toBe(internal);
    expect(sessionsMap.has(NEW_ID)).toBe(false);
    // 4. sessionManager.updateCliSessionId 调用 (反向 rename 替代 renameSdkSession)
    //    第一参数 applicationSid (= OLD_ID for resume path),走 manager 黑名单链
    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith(internal.applicationSid, NEW_ID);
    // 5. 旧 sessionManager.renameSdkSession 不再调 (反向 rename 不动 sessions.id)
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
  });

  it('carries exact runtime identity into native context-usage events', async () => {
    const bridge = makeBridge();
    const runtimeIdentity = {
      runtimeProvider: 'openrouter',
      model: 'gpt-5.6-sol-effective',
    };
    const thread = makeFakeThread([
      {
        type: 'thread.started',
        thread_id: 'runtime-thread',
        runtimeIdentity,
      },
      {
        type: 'server.notification',
        runtimeIdentity,
        notification: {
          method: 'thread/tokenUsage/updated',
          params: {
            tokenUsage: {
              last: { totalTokens: 12_345 },
              modelContextWindow: 272_000,
            },
          },
        },
      },
    ]);
    const internal = makeInternalSession(thread, 'runtime-thread');
    const threadLoop = (bridge as unknown as {
      threadLoop: { runTurnLoop: (i: InternalSession, k: string) => Promise<void> };
    }).threadLoop;

    await threadLoop.runTurnLoop(internal, 'runtime-thread');

    expect(internal.runtimeIdentity).toEqual(runtimeIdentity);
    expect(emits).toContainEqual(expect.objectContaining({
      kind: 'context-usage',
      payload: {
        usedTokens: 12_345,
        windowTokens: 272_000,
        runtimeIdentity,
        capacitySource: 'runtime-usage',
      },
    }));
  });

  it('runTurnLoop intentionallyClosed catch: 主动 abort → 静默退出不 emit finished:interrupted', async () => {
    const bridge = makeBridge();
    // thread.runStreamed 抛 abort error
    const abortErr = new Error('Aborted by abort()');
    const thread = makeFakeThread([], abortErr);
    const internal = makeInternalSession(thread, 'sess-x');
    internal.intentionallyClosed = true; // 关键：主动关闭标记
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set('sess-x', internal);

    const threadLoop = (bridge as unknown as { threadLoop: { runTurnLoop: unknown } }).threadLoop as {
      runTurnLoop: (i: InternalSession, k: string) => Promise<void>;
    };
    await threadLoop.runTurnLoop(internal, 'sess-x');

    // intentionallyClosed → 静默退出（REVIEW_4 H1+M5）
    // 不应 emit finished:interrupted（避免 manager 把已删 session 复活成幽灵）
    const finishedEvents = emits.filter((e) => e.kind === 'finished');
    expect(finishedEvents).toHaveLength(0);
  });
});
