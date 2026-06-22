/**
 * REVIEW_78 (deep-review 批 C4) 回归测试 — 2 MED fix：
 *
 * **MED-1 (reviewer-codex + lead 验证)**：respondExitPlanMode approve 热切档（targetMode ∈
 * {default, acceptEdits}）补 internal.permissionMode cache 同步 + 失败回滚 + 用户可见 error。
 * 修前漏：① 不写 s.permissionMode → canUseTool getPermissionMode() 读旧 mode（DB/SDK/cache 三分裂）
 * ② 失败只 console.warn 不回滚 DB ③ 失败无 error message。
 *
 * **MED-2 (reviewer-codex 提 + lead 裁 LOW→仍 fix 防御性 hardening)**：cancelPendingAndEmit 对三类
 * pending entry best-effort resolve，不依赖 closeSession 先 `await query.interrupt()` 同步驱动
 * can-use-tool abort listener resolve（SDK interrupt() 的 ctx.signal abort 同步性未契约保证）。
 *
 * **测试方式**：MED-1 走真 ClaudeSdkBridge.respondExitPlanMode 端到端（manual inject session +
 * 自定义 query stub 控制 setPermissionMode resolve/throw）；MED-2 直接 unit test
 * cancelPendingAndEmit 纯函数（构造三类 pending entry + spy resolver 断言被调）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession } from '../types';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';
import { cancelPendingAndEmit, runCloseSessionCleanup } from '../pending-cancellation';
import { sessionManager } from '@main/session/manager';

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    markRecentlyDeleted: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
}));

// session-repo mock：MED-1 路径调 setPermissionMode + get（emit upsert 用）。
// get 返回一个可变 record，让 setPermissionMode 写入后 get 能读回新值断言 DB 同步。
const dbState: { permissionMode: string } = { permissionMode: 'plan' };
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => ({ id: 'sess-c4', permissionMode: dbState.permissionMode })),
    setClaudeCodeSandbox: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setExtraAllowWrite: vi.fn(),
    setPermissionMode: vi.fn((_sid: string, mode: string) => {
      dbState.permissionMode = mode;
    }),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: vi.fn(() => undefined) },
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: { listForSession: vi.fn(() => []) },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

const emits: AgentEvent[] = [];

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** query stub：setPermissionMode 可配置 resolve / throw（MED-1 rollback 路径用）。 */
function makeQueryStub(opts: { setPermissionModeThrows?: boolean }): {
  query: Query;
  calls: string[];
} {
  const calls: string[] = [];
  const query = {
    async setPermissionMode(mode: string): Promise<void> {
      calls.push(mode);
      if (opts.setPermissionModeThrows) throw new Error('SDK setPermissionMode boom');
    },
  } as unknown as Query;
  return { query, calls };
}

function setupBridgeWithSession(opts: {
  sessionId: string;
  initialMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  setPermissionModeThrows?: boolean;
}): {
  bridge: ClaudeSdkBridge;
  internal: InternalSession;
  queryCalls: string[];
} {
  const bridge = new ClaudeSdkBridge({ emit: (e) => emits.push(e) });
  const internal = makeInternalSession({
    cwd: '/tmp/test',
    permissionMode: opts.initialMode,
    applicationSid: opts.sessionId,
  });
  const { query, calls } = makeQueryStub({
    setPermissionModeThrows: opts.setPermissionModeThrows,
  });
  internal.query = query;
  (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
    opts.sessionId,
    internal,
  );
  return { bridge, internal, queryCalls: calls };
}

/** 注入一条 pending ExitPlanMode entry，返回 requestId（caller 调 respondExitPlanMode 消费）。 */
function injectExitPlanEntry(internal: InternalSession, requestId: string): void {
  internal.pendingExitPlanModes.set(requestId, {
    payload: { type: 'exit-plan-mode', requestId, toolUseId: 'tu-1', plan: 'do X' },
    toolInput: { plan: 'do X' },
    timer: null,
    resolver: () => undefined, // resolver 行为本测不验证（canUseTool 侧），只验证 cache/DB/emit 副作用
  });
}

beforeEach(() => {
  emits.length = 0;
  dbState.permissionMode = 'plan';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('REVIEW_78 MED-1 — respondExitPlanMode 热切档同步 internal cache + 失败回滚', () => {
  it('approve + acceptEdits 成功：internal.permissionMode 同步到 acceptEdits（cache 不停留旧 plan）', async () => {
    const { bridge, internal, queryCalls } = setupBridgeWithSession({
      sessionId: 'sess-c4',
      initialMode: 'plan',
    });
    injectExitPlanEntry(internal, 'req-1');

    await bridge.respondExitPlanMode('sess-c4', 'req-1', {
      decision: 'approve',
      targetMode: 'acceptEdits',
    });

    // 修法核心：internal cache 同步到目标 mode（修前停留 'plan' → canUseTool 读脏 cache）
    expect(internal.permissionMode).toBe('acceptEdits');
    // SDK query.setPermissionMode 被调
    expect(queryCalls).toEqual(['acceptEdits']);
    // DB 同步
    expect(dbState.permissionMode).toBe('acceptEdits');
  });

  it('approve + acceptEdits 失败：internal cache 回滚到旧 plan + emit 用户可见 error', async () => {
    const { bridge, internal } = setupBridgeWithSession({
      sessionId: 'sess-c4',
      initialMode: 'plan',
      setPermissionModeThrows: true,
    });
    injectExitPlanEntry(internal, 'req-2');

    await bridge.respondExitPlanMode('sess-c4', 'req-2', {
      decision: 'approve',
      targetMode: 'acceptEdits',
    });

    // 修法核心：失败回滚 cache 到旧 mode（修前 optimistic 写后不回滚 → cache 脏）
    expect(internal.permissionMode).toBe('plan');
    // 修法核心：失败 emit 一条 error message（修前只 console.warn 用户不知道）
    const errs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { error?: boolean }).error === true,
    );
    expect(errs.length).toBe(1);
    expect((errs[0].payload as { text: string }).text).toMatch(/切换权限模式.*失败|回退到 plan/);
  });

  it('approve + plan：早返不动 cache / 不调 setPermissionMode（REVIEW_11 Bug 3 不变）', async () => {
    const { bridge, internal, queryCalls } = setupBridgeWithSession({
      sessionId: 'sess-c4',
      initialMode: 'plan',
    });
    injectExitPlanEntry(internal, 'req-3');

    await bridge.respondExitPlanMode('sess-c4', 'req-3', {
      decision: 'approve',
      targetMode: 'plan',
    });

    // plan 分支早返：cache 不动、SDK setPermissionMode 不调（CLI 已在 plan）
    expect(internal.permissionMode).toBe('plan');
    expect(queryCalls).toEqual([]);
  });
});

describe('REVIEW_78 MED-2 — cancelPendingAndEmit best-effort resolve 三类 pending', () => {
  it('清三类 Map 前 best-effort 调 resolver（不依赖 interrupt 同步驱动 abort listener）', () => {
    const internal = makeInternalSession({
      cwd: '/tmp/test',
      permissionMode: 'default',
      applicationSid: 'sess-c4',
    });
    const permResolver = vi.fn();
    const askResolver = vi.fn();
    const exitResolver = vi.fn();
    internal.pendingPermissions.set('p1', {
      payload: { type: 'permission-request', requestId: 'p1', toolName: 'Write', toolInput: {} },
      resolver: permResolver,
      timer: null,
    });
    internal.pendingAskUserQuestions.set('a1', {
      payload: { type: 'ask-user-question', requestId: 'a1', questions: [] },
      resolver: askResolver,
      timer: null,
    });
    internal.pendingExitPlanModes.set('e1', {
      payload: { type: 'exit-plan-mode', requestId: 'e1', plan: '' },
      toolInput: {},
      resolver: exitResolver,
      timer: null,
    });

    const emitted: AgentEvent[] = [];
    cancelPendingAndEmit(internal, 'sess-c4', (e) => emitted.push(e));

    // 修法核心：三类 resolver 都被调（修前只 emit cancelled + clear Map，不 resolve）
    expect(permResolver).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'session ended',
      interrupt: true,
    });
    expect(askResolver).toHaveBeenCalledTimes(1);
    expect(exitResolver).toHaveBeenCalledWith({
      decision: 'keep-planning',
      feedback: '会话已结束',
    });
    // Map 仍被清空
    expect(internal.pendingPermissions.size).toBe(0);
    expect(internal.pendingAskUserQuestions.size).toBe(0);
    expect(internal.pendingExitPlanModes.size).toBe(0);
    // emit 三条 cancelled
    expect(emitted.filter((e) => e.kind === 'waiting-for-user').length).toBe(3);
  });

  it('resolver 幂等：cancelPendingAndEmit 后 abort listener 再 resolve 同一 promise 不冲突', async () => {
    // 模拟 canUseTool 的真实 promise + resolver 包装（Promise resolve 首次 settle 后续 no-op）
    const internal = makeInternalSession({
      cwd: '/tmp/test',
      permissionMode: 'default',
      applicationSid: 'sess-c4',
    });
    let settled: unknown = null;
    let settleCount = 0;
    const realResolver = (v: unknown): void => {
      settleCount++;
      if (settled === null) settled = v;
    };
    internal.pendingPermissions.set('p1', {
      payload: { type: 'permission-request', requestId: 'p1', toolName: 'Write', toolInput: {} },
      resolver: realResolver,
      timer: null,
    });

    cancelPendingAndEmit(internal, 'sess-c4', () => undefined);
    // cancelPendingAndEmit 调一次 resolver
    expect(settleCount).toBe(1);
    expect(settled).toEqual({ behavior: 'deny', message: 'session ended', interrupt: true });

    // 模拟 abort listener 后到（Map 已清空 → get 落空 → 实际不会再调；此处直接再调验证幂等无害）
    realResolver({ behavior: 'deny', message: 'aborted', interrupt: true });
    // settled 保持首次值（真实 Promise resolve 幂等语义）
    expect(settled).toEqual({ behavior: 'deny', message: 'session ended', interrupt: true });
  });
});

describe('restart close cleanup — optional recentlyDeleted blacklist', () => {
  it('markRecentlyDeleted=false → cleanup 不把同 sid 加入 recentlyDeleted 黑名单', () => {
    const internal = makeInternalSession({
      cwd: '/tmp/test',
      permissionMode: 'default',
      applicationSid: 'sess-restart',
    });
    const sessions = new Map<string, InternalSession>([['sess-restart', internal]]);

    runCloseSessionCleanup({
      sessions,
      internal,
      key: 'sess-restart',
      sessionId: 'sess-restart',
      emit: () => undefined,
      markRecentlyDeleted: false,
    });

    expect(sessions.has('sess-restart')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-restart');
    expect(sessionManager.markRecentlyDeleted).not.toHaveBeenCalled();
  });
});

describe('restart close drain — closeSession waits for old SDK stream finally', () => {
  function setupBridgeForClose(sessionId: string): {
    bridge: ClaudeSdkBridge;
    internal: InternalSession;
    interruptSpy: ReturnType<typeof vi.fn>;
  } {
    const bridge = new ClaudeSdkBridge({ emit: (e) => emits.push(e) });
    const internal = makeInternalSession({
      cwd: '/tmp/test',
      permissionMode: 'default',
      applicationSid: sessionId,
    });
    const interruptSpy = vi.fn(async () => undefined);
    internal.query = { interrupt: interruptSpy } as unknown as Query;
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      sessionId,
      internal,
    );
    return { bridge, internal, interruptSpy };
  }

  it('closeSession 在 streamDrained resolve 前不返回，避免 restart 过早 jsonl precheck', async () => {
    const { bridge, internal, interruptSpy } = setupBridgeForClose('sess-drain-wait');
    let resolved = false;

    const closePromise = bridge.closeSession('sess-drain-wait').then(() => {
      resolved = true;
    });
    await nextMacrotask();

    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    internal.resolveStreamDrained();
    await closePromise;

    expect(resolved).toBe(true);
  });

  it('streamDrained 一直不来时 bounded timeout 后继续关闭，不无限卡住', async () => {
    vi.useFakeTimers();
    const { bridge, interruptSpy } = setupBridgeForClose('sess-drain-timeout');
    let resolved = false;

    const closePromise = bridge.closeSession('sess-drain-timeout').then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closePromise;

    expect(resolved).toBe(true);
  });
});
