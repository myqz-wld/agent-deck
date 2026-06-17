/**
 * codex sdk-bridge.consume-fork（thread-loop case 3 rename + restart-controller）单测
 * （codex-tests-plan P2 Step 2.1）。
 *
 * 镜像 claude `__tests__/sdk-bridge.consume-fork.test.ts` 但 codex 端架构差异显著：
 * - claude 一切走 `consume` private method（同 1 个流式 SDK query 处理）
 * - codex 拆 `ThreadLoop.runTurnLoop`（持 thread.started case 1/2/3 三态）+
 *   `RestartController.restartWithCodexSandbox`（兼容旧名称的 next-turn sandbox apply 控制器）
 *
 * 覆盖矩阵（与 plan §2 对应）：
 *   - thread-loop case 1 (新建路径): !threadId → 设 threadId + claimAsSdk + firstIdCb
 *   - thread-loop case 2 (恢复路径,id 一致): 仅 firstIdCb 不 rename
 *   - **thread-loop case 3 (恢复路径,id 不同) — symmetry-plan P2 MED-D 的核心目标 fix**:
 *     模拟 SDK 返不同 thread_id → sessions Map key 切 + sessionRepo.renameSdkSession
 *   - thread-loop intentionallyClosed catch: 静默退出不 emit finished
 *   - **restart-controller next-turn apply**: setCodexSandbox 后 emit session-upserted + patch live
 *     app-server thread options，不 close/create，不 abort current turn，不清 pending 队列
 *   - **restart-controller dormant path**: 没有 live session 时只持久化，下次 recover/create 生效
 *   - **restart-controller rollback**: DB / live patch 失败时回滚 sandbox + 二次 emit 让下拉回弹
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
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// 与 recovery test 同款 6 个入口模块 stub,绕过 vitest node 环境下 electron 模块的 'failed to install'
vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
  resolveCodexBinary: () => null,
  prependResolvedCodexPathDirs: vi.fn(),
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
    // REVIEW_101 R1：restart 接入 cancellation-epoch（getCloseEpoch baseline + cancelGuard）后新增
    // 依赖。mock 稳定返 0 → baseline === 后续检查值 → cancelGuard 返 false → 不 abort（这些测试不
    // 模拟 restart 期间 close，走正常 fallback / resume 路径，与原断言一致）。
    getCloseEpoch: vi.fn(() => 0),
  },
}));

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventBus } from '@main/event-bus';
import { emits, makeBridge } from './sdk-bridge/_setup';
import type { CodexAppServerStreamEvent } from '@main/adapters/codex-cli/app-server/client';
import type { CodexInput } from '@main/adapters/codex-cli/sdk-bridge/input-pack';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setCodexSandbox).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.updateCliSessionId).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  // REVIEW_101 R1：reset getCloseEpoch 默认返 0（无 close → cancelGuard 恒 false 不误 abort）。
  // close-during-restart 测试用 mockReturnValueOnce 序列模拟 epoch 变。
  vi.mocked(sessionManager.getCloseEpoch).mockReset();
  vi.mocked(sessionManager.getCloseEpoch).mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 创建 fake Thread:runStreamed 返回可控 events 序列。
 * 让我们直接 inject 到 InternalSession 触发 ThreadLoop.runTurnLoop 各种分支。
 */
function makeFakeThread(
  events: CodexAppServerStreamEvent[],
  throwBeforeEvents?: Error,
): InternalSession['thread'] {
  return {
    runStreamed: vi.fn(async () => {
      if (throwBeforeEvents) throw throwBeforeEvents;
      return {
        events: (async function* () {
          for (const ev of events) yield ev;
        })(),
      };
    }),
  } as unknown as InternalSession['thread'];
}

function makeInternalSession(
  thread: InternalSession['thread'],
  threadId: string | null = null,
): InternalSession {
  return {
    applicationSid: threadId ?? 'sess-test',
    threadId,
    cwd: '/tmp/x',
    thread: thread as unknown as InternalSession['thread'],
    pendingMessages: ['hi' as CodexInput],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
  };
}

describe('codex ThreadLoop.runTurnLoop thread.started 三态（symmetry-plan P2 MED-D）', () => {
  it('case 1 (新建路径): !threadId → 设 internal.threadId + claimAsSdk + firstIdCb(NEW_ID)', async () => {
    const bridge = makeBridge();
    const thread = makeFakeThread([
      { type: 'thread.started', thread_id: 'NEW_ID' },
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
      { type: 'thread.started', thread_id: SAME_ID },
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
      { type: 'thread.started', thread_id: NEW_ID },
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

describe('codex RestartController.restartWithCodexSandbox（next-turn apply）', () => {
  it('live session: persists + emits upsert + patches thread options without abort/create/queue loss', async () => {
    const bridge = makeBridge();
    const updateSandboxMode = vi.fn();
    const thread = {
      runStreamed: vi.fn(),
      updateSandboxMode,
    } as unknown as InternalSession['thread'];
    const internal = makeInternalSession(thread, 'sess-live');
    const currentTurn = new AbortController();
    internal.currentTurn = currentTurn;
    internal.currentTurnId = 'turn-active';
    internal.pendingMessages = ['queued-next-turn' as CodexInput];
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set('sess-live', internal);

    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-live',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'working',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp/ref'],
      })
      .mockReturnValue({
        id: 'sess-live',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'working',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write',
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp/ref'],
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    const result = await bridge.restartWithCodexSandbox('sess-live', 'workspace-write', 'ignored');

    expect(result).toBe('sess-live');
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(1);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-live', 'workspace-write');
    expect(upsertedEmits).toHaveLength(1);
    expect(upsertedEmits[0]).toMatchObject({ id: 'sess-live', codexSandbox: 'workspace-write' });
    expect(updateSandboxMode).toHaveBeenCalledWith('workspace-write', {
      networkAccessEnabled: true,
      additionalDirectories: ['/tmp/ref'],
    });
    expect(currentTurn.signal.aborted).toBe(false);
    expect(internal.pendingMessages).toEqual(['queued-next-turn']);
    expect(bridge.createCalls).toHaveLength(0);
    expect(sessionManager.releaseSdkClaim).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('dormant session: persists DB only and does not create/resume even if jsonl is missing', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-dormant',
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
      })
      .mockReturnValue({
        id: 'sess-dormant',
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
        codexSandbox: 'danger-full-access',
      });

    await expect(
      bridge.restartWithCodexSandbox('sess-dormant', 'danger-full-access', '   '),
    ).resolves.toBe('sess-dormant');

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(1);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-dormant', 'danger-full-access');
    expect(bridge.createCalls).toHaveLength(0);
  });

  it('waits for an existing same-session recovery before applying the sandbox change', async () => {
    const bridge = makeBridge();
    let releaseRecovery!: () => void;
    const recovering = (bridge as unknown as { recovering: Map<string, Promise<unknown>> }).recovering;
    recovering.set(
      'sess-wait',
      new Promise<void>((resolve) => {
        releaseRecovery = () => {
          recovering.delete('sess-wait');
          resolve();
        };
      }),
    );
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-wait',
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

    const p = bridge.restartWithCodexSandbox('sess-wait', 'workspace-write', 'ignored');
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionRepo.setCodexSandbox).not.toHaveBeenCalled();

    releaseRecovery();
    await p;
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-wait', 'workspace-write');
  });

  it('forward setCodexSandbox throw → rollback attempt + error bubble + no createSession', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dbfail',
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
    vi.mocked(sessionRepo.setCodexSandbox)
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      })
      .mockImplementationOnce(() => undefined);

    await expect(
      bridge.restartWithCodexSandbox('sess-dbfail', 'workspace-write', 'ignored'),
    ).rejects.toThrow(/SQLITE_BUSY/);

    const errMsgs = emits.filter(
      (e) =>
        e.kind === 'message' &&
        (e.payload as { error?: boolean }).error === true &&
        ((e.payload as { text?: string }).text ?? '').includes('切到 sandbox'),
    );
    expect(errMsgs).toHaveLength(1);
    expect(bridge.createCalls).toHaveLength(0);
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(2, 'sess-dbfail', 'read-only');
  });

  it('live thread patch throw → rolls back DB and emits reverted session-upserted', async () => {
    const bridge = makeBridge();
    const thread = {
      runStreamed: vi.fn(),
      updateSandboxMode: vi.fn(() => {
        throw new Error('patch failed');
      }),
    } as unknown as InternalSession['thread'];
    const internal = makeInternalSession(thread, 'sess-live-fail');
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set('sess-live-fail', internal);

    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
      })
      .mockReturnValueOnce({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write',
      })
      .mockReturnValue({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    await expect(
      bridge.restartWithCodexSandbox('sess-live-fail', 'workspace-write', 'ignored'),
    ).rejects.toThrow(/patch failed/);

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(2);
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(1, 'sess-live-fail', 'workspace-write');
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(2, 'sess-live-fail', 'read-only');
    expect(upsertedEmits).toHaveLength(2);
    expect(upsertedEmits[0]).toMatchObject({ codexSandbox: 'workspace-write' });
    expect(upsertedEmits[1]).toMatchObject({ codexSandbox: 'read-only' });
    expect(bridge.createCalls).toHaveLength(0);

    spy.mockRestore();
  });

  it('record 不存在 → throw not found', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    await expect(
      bridge.restartWithCodexSandbox('sess-ghost', 'workspace-write', 'x'),
    ).rejects.toThrow(/not found in repo/);
  });
});
