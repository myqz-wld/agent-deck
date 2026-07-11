/**
 * codex sdk-bridge createSession resume earlyErrCb cleanup 单测（codex-tests-plan
 * follow-up — 补 CHANGELOG_115 §Phase 2 留下的 R2-1 + R3-1 守门）。
 *
 * 覆盖 `sdk-bridge/index.ts:337-388` createSession resume path 的 earlyErrCb wrapper
 * 两条修复点（commit `6e0eb37` R2-1 + commit `726af8d` R3-1）：
 *
 * - **R2-1（30s 内 earlyErr 路径）**：`thread.runStreamed` 抛错触发 earlyErrCb 时
 *   reject 之前 `sessions.delete + releaseSdkClaim + emit finished:error`，让后续
 *   sendMessage 走 sessions Map miss → recoverer 自愈正常路径。修前半初始化 sessions Map
 *   + sdkClaim 不清理，sendMessage `if (!s)` 命中绕过 recoverer 直接 throw。
 *
 * - **R3-1（30s timeout 后 late earlyErr 路径）**：`resolved=true` 分支也跑 cleanup
 *   + 补 emit error message。修前 `if (resolved) return` 短路 stale internal.thread
 *   + 后续 sendMessage 同样绕过 recoverer。
 *
 * **测试 infra 关键差异（与 _setup.ts 现有 TestCodexBridge 不同）**：
 * 这两个修复点在 createSession resume path 的 earlyErrCb closure 里，必须真跑
 * createSession（不能用 TestCodexBridge override createSession 的捷径）。所以本文件：
 *   1. **不用 TestCodexBridge / makeBridge**，直接 `new CodexSdkBridge({emit})`
 *   2. mock `CodexAppServerClient` 注入 fake app-server client，其 `resumeThread` / `startThread` 返
 *      ControlledThread（`runStreamed` 受 test 控制 reject/resolve 时机）
 *   3. R3-1 case 用 `vi.useFakeTimers()` 推进 30s 触发 fallback setTimeout 后再 reject
 *      runStreamed 模拟 late earlyErr
 *
 * 抽出 fake codex SDK helper 到本文件局部（不进 _setup.ts），原因：仅本 follow-up
 * 用到，其他 test 不复用；放局部避免 _setup.ts 暴露 module-level mutable nextThread
 * 让 recovery / consume-fork 误用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

const appServerClientMock = vi.hoisted(() => {
  const state = {
    nextThread: null as unknown,
    CodexAppServerClient: vi.fn(() => ({
      resumeThread: vi.fn(() => {
        if (!state.nextThread) throw new Error('test setup forgot to assign nextThread');
        return state.nextThread;
      }),
      startThread: vi.fn(() => {
        if (!state.nextThread) throw new Error('test setup forgot to assign nextThread');
        return state.nextThread;
      }),
      dispose: vi.fn(),
    })),
  };
  return state;
});

// 与 recovery / consume-fork test 同款 6 个入口模块 stub,绕过 vitest node 环境下
// electron 模块的 'failed to install'(详 _setup.ts 同款注释)
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
vi.mock('@main/adapters/codex-cli/app-server/client', () => ({
  CodexAppServerClient: appServerClientMock.CodexAppServerClient,
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn(), setCodexSandbox: vi.fn(), setModel: vi.fn() },
  }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(async () => undefined),
    // REVIEW_99 R3 cancellation-epoch: recoverAndSend 入口捕 baseline。返 0 恒定 = 不 close →
    // 合法 resume 不误 abort（本 test 验 earlyErr cleanup 后 recoverer 自愈,非 close 场景）。
    getCloseEpoch: vi.fn(() => 0),
  },
}));

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import { THREAD_STARTED_FALLBACK_MS } from '@main/adapters/codex-cli/sdk-bridge/constants';
import type { AgentEvent } from '@shared/types';

const emits: AgentEvent[] = [];

/**
 * Test seam: runStreamed 受外部控制 reject/resolve 时机。
 *
 * app-server thread `runStreamed(input, opts) => Promise<{ events: AsyncIterable<...> }>`
 * 真实接口让 thread loop `await runStreamed` 拿到 events 后 `for await` 消费。本 fake
 * 让 runStreamed 返回 pending Promise,test 通过 `rejectStreamed` / `resolveStreamed`
 * 控制何时 fulfill — 触发 thread-loop catch 路径(reject) 或正常 events stream(resolve)。
 *
 * **关键**: app-server thread 接口允许 runStreamed 是同步 fn 返回 Promise(类型 sig
 * `(input, opts) => Promise<...>`),不必标 async。这让我们可以同步注册 reject 回调。
 */
class ControlledThread {
  rejectStreamed: ((err: Error) => void) | null = null;
  resolveStreamed: ((events: { events: AsyncIterable<unknown> }) => void) | null = null;

  runStreamed = vi.fn(
    () =>
      new Promise<{ events: AsyncIterable<unknown> }>((resolve, reject) => {
        this.rejectStreamed = reject;
        this.resolveStreamed = resolve;
      }),
  );
}

/**
 * 推进 microtask 链让 await/Promise resolution 跑完。
 * await Promise.resolve() 推进一个 microtask;真实 createSession resume 内 await 链
 * 较深(ensureCodex → new CodexAppServerClient → resumeThread → emit → await new Promise
 * → runTurnLoop → await runStreamed),需要多次 flush。
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

/** 当前 case 即将注入的 fake thread。每个 case beforeEach 重置 */
let nextThread: ControlledThread | null = null;

beforeEach(() => {
  emits.length = 0;
  nextThread = null;
  appServerClientMock.nextThread = null;
  appServerClientMock.CodexAppServerClient.mockClear();
  mcpSessionTokenMap.clearAll();
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setCodexSandbox).mockReset();
  vi.mocked(sessionRepo.setModel).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.unarchive).mockReset();
  vi.mocked(sessionManager.delete).mockReset();
  vi.mocked(sessionManager.delete).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers(); // R3-1 case 用 fake timers,防漏 cleanup 影响下一 case
  vi.restoreAllMocks();
});

function makeBridge(): CodexSdkBridge {
  return new CodexSdkBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}

/** 取 bridge 私有 sessions Map(只读断言用)。test-only TS escape hatch */
function getSessionsMap(bridge: CodexSdkBridge): Map<string, unknown> {
  return (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
}

function getInjectedMcpToken(): string {
  const calls = appServerClientMock.CodexAppServerClient.mock.calls as unknown as Array<
    [{ env?: Record<string, string> }]
  >;
  const options = calls.at(-1)?.[0];
  const token = options?.env?.AGENT_DECK_MCP_TOKEN;
  if (!token) throw new Error('CodexAppServerClient was not given a per-session MCP token');
  return token;
}

describe('codex sdk-bridge strict canonical startup cleanup', () => {
  it('rejects an early startup error and removes the provisional session', async () => {
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    const bridge = makeBridge();
    const createPromise = bridge.createSession({
      cwd: '/tmp/new-early-error',
      prompt: 'hi',
      awaitCanonicalId: true,
    });

    await flushMicrotasks();
    const token = getInjectedMcpToken();
    const tempSid = emits.find((event) => event.kind === 'session-start')?.sessionId;
    expect(tempSid).toBeTruthy();
    nextThread.rejectStreamed!(new Error('spawn boom'));

    await expect(createPromise).rejects.toThrow(/spawn boom/);
    expect(sessionManager.delete).toHaveBeenCalledWith(tempSid);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith(tempSid);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(getSessionsMap(bridge).has(tempSid!)).toBe(false);
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
  });

  it('rejects thread.started timeout and removes the provisional session', async () => {
    vi.useFakeTimers();
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    const bridge = makeBridge();
    const createPromise = bridge.createSession({
      cwd: '/tmp/new-timeout',
      prompt: 'hi',
      awaitCanonicalId: true,
    });
    const rejection = expect(createPromise).rejects.toThrow(/30 秒内未发出 thread_id/);

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const token = getInjectedMcpToken();
    const tempSid = emits.find((event) => event.kind === 'session-start')?.sessionId;
    expect(tempSid).toBeTruthy();
    await vi.advanceTimersByTimeAsync(THREAD_STARTED_FALLBACK_MS);
    await rejection;

    expect(sessionManager.delete).toHaveBeenCalledWith(tempSid);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith(tempSid);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(getSessionsMap(bridge).has(tempSid!)).toBe(false);
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
  });
});

describe('codex sdk-bridge createSession resume earlyErrCb cleanup', () => {
  // ─── R2-1 path 1: 30s 内 earlyErr → cleanup + reject + finished:error 一次 ───────
  it('R2-1: thread.runStreamed 立即抛错 → earlyErrCb cleanup sessions Map + releaseSdkClaim + emit finished:error 一次 + reject Promise', async () => {
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    const bridge = makeBridge();

    // createSession resume 不 await(本路径会 reject)
    const createPromise = bridge
      .createSession({ cwd: '/tmp/r1', prompt: 'hi', resume: 'sess-r1' })
      .catch((e: unknown) => e);

    // flush microtask 链让 ensureCodex → resumeThread → emit session-start + user msg
    // → await new Promise + runTurnLoop → await runStreamed 进 pending
    await flushMicrotasks();

    // resume 主路径已 emit session-start + user msg
    const sessionStarts = emits.filter((e) => e.kind === 'session-start');
    expect(sessionStarts).toHaveLength(1);
    expect(sessionStarts[0].sessionId).toBe('sess-r1');
    expect(appServerClientMock.CodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_DECK_MCP_TOKEN: expect.any(String),
          AGENT_DECK_ORIGIN: 'sdk',
        }),
      }),
    );
    // sessions Map 已 set(resume 主路径登记)
    expect(getSessionsMap(bridge).has('sess-r1')).toBe(true);
    expect(sessionManager.claimAsSdk).toHaveBeenCalledWith('sess-r1');

    // 触发 runStreamed reject 模拟 codex 子进程 spawn 立即失败
    expect(nextThread.rejectStreamed).not.toBeNull();
    nextThread.rejectStreamed!(new Error('codex spawn failed at first turn'));

    // 等 createPromise reject
    const result = await createPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Codex resume early error.*codex spawn failed/);

    // R2-1 cleanup 验证: sessions Map deleted + releaseSdkClaim
    expect(getSessionsMap(bridge).has('sess-r1')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-r1');

    // emit finished:error 一次 (唯一,不重复)
    const finishedErr = emits.filter(
      (e) =>
        e.kind === 'finished' && (e.payload as { subtype?: string }).subtype === 'error',
    );
    expect(finishedErr).toHaveLength(1);
    expect(finishedErr[0].sessionId).toBe('sess-r1');

    // 30s timeout 路径不应触发 (runStreamed 立即 reject 已 clearTimeout)
    const warn30s = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('30 秒内未发出 thread.started'),
    );
    expect(warn30s).toHaveLength(0);

    // R3-1 路径专属 late error message 不应在 R2-1 emit
    const lateErrMsg = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('30s timeout 后 late error'),
    );
    expect(lateErrMsg).toHaveLength(0);
  });

  // ─── R3-1 path 2: 30s timeout 后 late earlyErr → cleanup + emit error msg + 不抛 ─────
  it('R3-1: 30s timeout 后 late earlyErr → cleanup sessions Map + releaseSdkClaim + emit late error message + emit finished:error 一次 (createPromise 已 resolve 不抛)', async () => {
    vi.useFakeTimers();
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    const bridge = makeBridge();

    // createSession resume 不 await(30s timeout 会 resolve(opts.resume))
    const createPromise = bridge.createSession({
      cwd: '/tmp/r2',
      prompt: 'hi',
      resume: 'sess-r2',
    });

    // flush microtasks 让 ensureCodex → resumeThread → emit → await runStreamed pending +
    // setTimeout 注册 (vi.useFakeTimers 让 setTimeout 受 fake clock 控)
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    // 推进 30s + 1ms 触发 fallback setTimeout
    await vi.advanceTimersByTimeAsync(30_001);
    await flushMicrotasks();

    // createSession 应 resolve(opts.resume) — 30s warn message + resolve(opts.resume!)
    const handle = await createPromise;
    expect(handle.sessionId).toBe('sess-r2');

    // 30s warn message 已 emit (info,非 error)
    const warn30s = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('30 秒内未发出 thread.started'),
    );
    expect(warn30s).toHaveLength(1);
    expect((warn30s[0].payload as { error?: boolean }).error).not.toBe(true);

    // 此时 sessions Map 仍持 sess-r2 (resume 主路径已登记,30s warn 路径不 cleanup)
    expect(getSessionsMap(bridge).has('sess-r2')).toBe(true);

    // 触发 late earlyErr (超过 30s 后 codex 子进程才报错)
    expect(nextThread.rejectStreamed).not.toBeNull();
    nextThread.rejectStreamed!(new Error('late spawn fail after timeout'));

    // flush microtasks 让 thread-loop catch + earlyErrCb 跑完
    await flushMicrotasks();

    // R3-1 cleanup 验证: sessions Map deleted + releaseSdkClaim
    expect(getSessionsMap(bridge).has('sess-r2')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-r2');

    // emit finished:error 一次 (late path 也 emit,not 跳过)
    const finishedErr = emits.filter(
      (e) =>
        e.kind === 'finished' && (e.payload as { subtype?: string }).subtype === 'error',
    );
    expect(finishedErr).toHaveLength(1);
    expect(finishedErr[0].sessionId).toBe('sess-r2');

    // emit late error message (R3-1 path 2 特征文案 "30s timeout 后 late error")
    const lateErrMsg = emits.filter((e) => {
      const p = e.payload as { text?: string; error?: boolean };
      return (
        p.error === true &&
        (p.text ?? '').includes('30s timeout 后 late error') &&
        (p.text ?? '').includes('late spawn fail after timeout')
      );
    });
    expect(lateErrMsg).toHaveLength(1);
    expect(lateErrMsg[0].sessionId).toBe('sess-r2');
    // 文案应提示「下条消息将走自愈路径」让用户知情
    expect((lateErrMsg[0].payload as { text: string }).text).toMatch(/自愈|recover/i);
  });

  // ─── R2-1 cleanup 让后续 sendMessage 走 recoverer (联合验证 cleanup effective) ──────
  it('R2-1 联合 recoverer: earlyErrCb cleanup 后 sendMessage 走 recoverer 自愈路径 (sessions Map miss + sdkClaim release → recoverAndSend emit placeholder)', async () => {
    // sessionRepo.get 返 record 让 recoverer.recoverAndSend lookup 命中
    //
    // **stderr 预期噪音说明**: 本 case 用裸 cwd `/tmp/r3` 不存在 → recoverer 走 cwd fallback
    // 启发式命中 `/tmp` + 同时 startedAt=1 让 jsonl 探测扫到 1970 路径 missing → fresh thread
    // fallback + rename。这两条 stderr 是 recoverer 真实路径的副作用,**不影响本 case 核心断言**
    // (R2-1 cleanup 让 sendMessage 进 recoverer 入口 + emit placeholder)。要消除噪音需 mock
    // facade.cwdExists / jsonlExistsThunk(就要换回 TestCodexBridge override 模式),与本文件
    // 必须真跑 createSession 的设计目标冲突,接受 stderr 噪音换 cleanup → recoverer 端到端守门。
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-r3',
      agentId: 'codex-cli',
      cwd: '/tmp/r3',
      title: 'r3',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
    });

    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    const bridge = makeBridge();

    // 1) 第一次 createSession resume 触发 R2-1 path 1
    const createPromise = bridge
      .createSession({ cwd: '/tmp/r3', prompt: 'first', resume: 'sess-r3' })
      .catch((e: unknown) => e);
    await flushMicrotasks();
    nextThread.rejectStreamed!(new Error('first spawn fail'));
    await createPromise;

    // 验证 R2-1 cleanup 完成
    expect(getSessionsMap(bridge).has('sess-r3')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-r3');

    // 2) 现在再 sendMessage('sess-r3', ...) 应走 recoverer (sessions miss → recoverAndSend)
    // 让第二轮 nextThread 不抛错 — 但 recoverer 调 createThunk 我们让它 block 在 await runStreamed
    // 从而验证 placeholder + createSession 启动这一段 (不必走完整 turn)
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;

    // 不 await sendMessage,让 recoverer.recoverAndSend 跑到 createThunk 启动 + emit placeholder
    const sendPromise = bridge.sendMessage('sess-r3', 'second').catch((e: unknown) => e);
    await flushMicrotasks();

    // recoverer 应 emit placeholder 「Codex 通道已断开,正在自动恢复」
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].sessionId).toBe('sess-r3');
    // placeholder 不打 error: true (info 性质)
    expect((placeholders[0].payload as { error?: boolean }).error).not.toBe(true);

    // recoverer 已调 sessionRepo.get 拿 record (验证走的是 recoverAndSend 而非直接 throw)
    expect(sessionRepo.get).toHaveBeenCalledWith('sess-r3');

    // Unified continuation preparation may fail before a replacement provider thread starts in
    // this deliberately DB-less harness. The cleanup invariant under test is already proven by the
    // placeholder + repository lookup above; settle the caught recovery result without assuming a
    // fixed async depth or forcing runStreamed to exist.
    const recoveryResult = await sendPromise;
    expect(recoveryResult).toBeInstanceOf(Error);
  });
});
