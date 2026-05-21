/**
 * codex sdk-bridge.consume-fork（thread-loop case 3 rename + restart-controller）单测
 * （codex-tests-plan P2 Step 2.1）。
 *
 * 镜像 claude `__tests__/sdk-bridge.consume-fork.test.ts` 但 codex 端架构差异显著：
 * - claude 一切走 `consume` private method（同 1 个流式 SDK query 处理）
 * - codex 拆 `ThreadLoop.runTurnLoop`（持 thread.started case 1/2/3 三态）+
 *   `RestartController.restartWithCodexSandbox`（冷切 sandbox 控制器,持单飞 + DB rollback）
 *
 * 覆盖矩阵（与 plan §2 对应）：
 *   - thread-loop case 1 (新建路径): !threadId → 设 threadId + claimAsSdk + firstIdCb
 *   - thread-loop case 2 (恢复路径,id 一致): 仅 firstIdCb 不 rename
 *   - **thread-loop case 3 (恢复路径,id 不同) — symmetry-plan P2 MED-D 的核心目标 fix**:
 *     模拟 SDK 返不同 thread_id → sessions Map key 切 + sessionRepo.renameSdkSession
 *   - thread-loop intentionallyClosed catch: 静默退出不 emit finished
 *   - **restart-controller HIGH-A 单飞**: 2 并发 restartWithCodexSandbox 同 sid → 串行执行
 *   - **restart-controller MED-A emit session-upserted (前置)**: setCodexSandbox 后立即 emit
 *   - **restart-controller MED-A emit session-upserted (回滚)**: createSession reject → catch 内
 *     回滚 sandbox + 二次 emit 让下拉回弹
 *   - restart-controller no-rename common case: codex SDK 实测 resume 永远返同 id, no rename 路径
 *
 * **未覆盖** (R2-1 sessions cleanup + R3-1 late earlyErr cleanup)：
 * 这两个修复点位于 createSession resume path 的 earlyErrCb wrapper 内,需要真 createSession
 * + fake codex SDK + 控制 thread.runStreamed 抛错 — 测试 infra 工作量较大。本 plan 范围内
 * 留 follow-up（test infrastructure 已就位,后续可补 fake codex SDK module 让真 createSession
 * 跑起来）。
 *
 * Mock 策略与 recovery test 一致 + 加 eventBus spy（restart-controller emit session-upserted）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// 与 recovery test 同款 6 个入口模块 stub,绕过 vitest node 环境下 electron 模块的 'failed to install'
vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
}));
vi.mock('@main/store/image-uploads', () => ({
  deleteUploadIfExists: vi.fn(async () => undefined),
}));
vi.mock('@main/paths', () => ({
  getImageUploadsDir: () => '/tmp/test-image-uploads',
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock(),
}));
vi.mock('@main/codex-config/agent-deck-mcp-injector', () => ({
  buildAgentDeckMcpConfigForCodex: () => null,
  mergeCodexConfig: (a: unknown) => a,
  // plan codex-handoff-team-alignment-20260518 P2 Step 2.5b: ensureCodex 用此常量当 env key
  AGENT_DECK_MCP_TOKEN_ENV: 'AGENT_DECK_MCP_TOKEN',
}));
vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  invalidateCodexInstance: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn(), setCodexSandbox: vi.fn() },
  }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
    unarchive: vi.fn(),
  },
}));

vi.mock('@main/adapters/codex-cli/sdk-loader', () => makeBareSdkLoaderMock());

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventBus } from '@main/event-bus';
import { emits, makeBridge } from './sdk-bridge/_setup';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import type { Input } from '@openai/codex-sdk';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setCodexSandbox).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.updateCliSessionId).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 创建 fake Thread:runStreamed 返回可控 events 序列。
 * 让我们直接 inject 到 InternalSession 触发 ThreadLoop.runTurnLoop 各种分支。
 */
function makeFakeThread(events: ThreadEvent[], throwBeforeEvents?: Error): Thread {
  return {
    runStreamed: vi.fn(async () => {
      if (throwBeforeEvents) throw throwBeforeEvents;
      return {
        events: (async function* () {
          for (const ev of events) yield ev;
        })(),
      };
    }),
  } as unknown as Thread;
}

function makeInternalSession(thread: Thread, threadId: string | null = null): InternalSession {
  return {
    applicationSid: threadId ?? 'sess-test',
    threadId,
    cwd: '/tmp/x',
    thread,
    pendingMessages: ['hi' as Input],
    currentTurn: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
  };
}

describe('codex ThreadLoop.runTurnLoop thread.started 三态（symmetry-plan P2 MED-D）', () => {
  it('case 1 (新建路径): !threadId → 设 internal.threadId + claimAsSdk + firstIdCb(NEW_ID)', async () => {
    const bridge = makeBridge();
    const thread = makeFakeThread([
      { type: 'thread.started', thread_id: 'NEW_ID' } as ThreadEvent,
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
      { type: 'thread.started', thread_id: SAME_ID } as ThreadEvent,
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
      { type: 'thread.started', thread_id: NEW_ID } as ThreadEvent,
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

describe('codex RestartController.restartWithCodexSandbox（symmetry-plan P2 HIGH-A + MED-A）', () => {
  it('MED-A: createSession 成功 → emit session-upserted (新 sandbox)', async () => {
    const bridge = makeBridge();
    // setCodexSandbox 调用顺序: 1) workspace-write (前置)
    vi.mocked(sessionRepo.get).mockImplementation((id: string) => {
      if (id !== 'sess-restart') return null;
      // 模拟两次 get: 第 1 次 (RestartController 取 oldSandbox) 返 read-only
      // 第 2 次 (前置 set 后 emit) 返 workspace-write
      return {
        id,
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write', // setCodexSandbox 后 get 反映新值
      };
    });
    // 第一次 get 返 oldSandbox=read-only,后续 get 返 new sandbox
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-restart',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only', // old
      })
      .mockReturnValue({
        id: 'sess-restart',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write', // new (setCodexSandbox 后)
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    const result = await bridge.restartWithCodexSandbox(
      'sess-restart',
      'workspace-write',
      'continue please',
    );

    // createSession 成功 → 应 emit 1 次 session-upserted (前置成功路径,无 rollback)
    expect(upsertedEmits).toHaveLength(1);
    expect(upsertedEmits[0]).toMatchObject({ id: 'sess-restart', codexSandbox: 'workspace-write' });
    // setCodexSandbox 调用 1 次 (前置)
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(1);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-restart', 'workspace-write');
    // codex SDK resume 不会改 id,handle.sessionId === 'sess-restart' (TestBridge 默认)
    expect(result).toBe('sess-restart');
    // 不 rename（无 fork）
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('MED-A: createSession 抛错 → catch 内回滚 + 第二次 emit session-upserted (旧 sandbox 让下拉回弹)', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('codex spawn failed');
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-rollback',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only', // old
      })
      // 第 2 次 (前置 set 后 emit): 已切到 workspace-write
      .mockReturnValueOnce({
        id: 'sess-rollback',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write',
      })
      // 第 3 次 (catch 回滚后 emit): 回到 read-only
      .mockReturnValue({
        id: 'sess-rollback',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only', // rolled back
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    await expect(
      bridge.restartWithCodexSandbox('sess-rollback', 'workspace-write', 'go'),
    ).rejects.toThrow(/codex spawn failed/);

    // 应 emit 2 次 session-upserted: 1) 前置成功 (workspace-write) 2) catch 回滚 (read-only)
    expect(upsertedEmits).toHaveLength(2);
    expect(upsertedEmits[0]).toMatchObject({ codexSandbox: 'workspace-write' });
    expect(upsertedEmits[1]).toMatchObject({ codexSandbox: 'read-only' }); // 回弹

    // setCodexSandbox 调 2 次: 1) 前置 workspace-write 2) catch 回滚 read-only
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(2);
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(1, 'sess-rollback', 'workspace-write');
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(2, 'sess-rollback', 'read-only');

    // emit 一条 error message 让用户看到失败原因
    const errMsgs = emits.filter(
      (e) =>
        e.kind === 'message' &&
        (e.payload as { error?: boolean }).error === true &&
        ((e.payload as { text?: string }).text ?? '').includes('切到 sandbox'),
    );
    expect(errMsgs).toHaveLength(1);

    spy.mockRestore();
  });

  it('HIGH-A 单飞: 2 并发 restartWithCodexSandbox 同 sid → 串行执行(后者等前者完成)', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block'; // 让前一个 restart 卡在 createSession
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-concurrent',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'read-only',
    });

    // 第一波: 不 await,让 inflight 注册
    const p1 = bridge
      .restartWithCodexSandbox('sess-concurrent', 'workspace-write', 'first')
      .catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    // 第二波同 sid: 应等 p1 inflight
    const p2 = bridge
      .restartWithCodexSandbox('sess-concurrent', 'danger-full-access', 'second')
      .catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // 此刻 createSession 只被调过 1 次（第二条等同一 inflight）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].codexSandbox).toBe('workspace-write');

    // 解锁第一波,让 p1 完成；第二波然后开始
    bridge.unblock?.();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('second wave fast-fail');
    await p1;
    await p2;

    // 第二波最终也跑了 createSession（被 reject 但确实进了）
    expect(bridge.createCalls).toHaveLength(2);
  });

  it('handoffPrompt 空 → 直接抛 (codex SDK runStreamed 协议约束)', async () => {
    const bridge = makeBridge();
    await expect(
      bridge.restartWithCodexSandbox('sess-x', 'workspace-write', '   '),
    ).rejects.toThrow(/handoffPrompt 非空/);
    // createSession 不被调
    expect(bridge.createCalls).toHaveLength(0);
  });

  it('record 不存在 → throw not found', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    await expect(
      bridge.restartWithCodexSandbox('sess-ghost', 'workspace-write', 'x'),
    ).rejects.toThrow(/not found in repo/);
  });
});
