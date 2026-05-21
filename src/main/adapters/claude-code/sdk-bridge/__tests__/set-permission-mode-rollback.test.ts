/**
 * plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.1 测试 (A1-MED-1 claude):
 * setPermissionMode SDK throw 时回滚 in-memory cache, 与 restartWithPermissionMode 失败回滚 DB
 * 同款 fail-fast 模式。
 *
 * **Phase 1.6 (deep-review-batch-a1-b-followup-r3-20260519, M4) 修法**：拒绝 inline 复制 try/catch
 * 合约 (test 与 production 漂移风险，H4 教训) — 改用真实 ClaudeSdkBridge factory + MockSdkQuery
 * stateful 调 bridge.setPermissionMode 端到端验证 (不变量 3)。原 inline 复制 try/catch case 删，
 * 改成 import 真 bridge + manual inject session 走真 setPermissionMode 路径。
 *
 * **测试覆盖**:
 * - happy: SDK setPermissionMode resolve → s.permissionMode = newMode (新值)
 * - SDK throw → s.permissionMode 回滚 oldMode + throw 给 caller
 * - 多次切档串行,失败 / 成功混合 → cache 状态严格跟成功结果走
 *
 * **测试方式**:
 * - 不再 inline 复制 try/catch — caller 调真实 ClaudeSdkBridge.setPermissionMode
 * - mock SDK Query 用 _shared/mocks/sdk-query.ts MockSdkQuery 替代 ad-hoc inline
 * - manual inject InternalSession 进 bridge.sessions Map (private cast) 让 setPermissionMode 跑通
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkBridge } from '../index';
import { makeInternalSession, type InternalSession } from '../types';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';

// Phase 1.6 用真 ClaudeSdkBridge factory; sessionManager mock 让 bridge ctor 不撞依赖
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
}));

// session-repo / settings-store / sandbox-config / agent-deck-team-repo 都不会被
// setPermissionMode 路径触发（仅 sessions Map + query.setPermissionMode 链），但 bridge ctor
// import 会触发 module-level side effect — 给基础 mock 防 SQLite 真碰
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setClaudeCodeSandbox: vi.fn(),
    setModel: vi.fn(),
    setExtraAllowWrite: vi.fn(),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: vi.fn(() => undefined) },
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: { listForSession: vi.fn(() => []) },
}));

const emits: AgentEvent[] = [];

/**
 * 真 bridge factory + manual inject InternalSession 让 setPermissionMode 跑通。
 * 返回 { bridge, internal, mockQuery } 三件套让 caller 自由 mock query.setPermissionMode 行为。
 */
function setupBridgeWithSession(opts: {
  sessionId: string;
  initialMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
}): {
  bridge: ClaudeSdkBridge;
  internal: InternalSession;
  mockQuery: MockSdkQuery;
} {
  const bridge = new ClaudeSdkBridge({
    emit: (e) => emits.push(e),
  });
  const internal = makeInternalSession({
    cwd: '/tmp/test',
    permissionMode: opts.initialMode,
    applicationSid: 'sess-test',
  });
  const mockQuery = new MockSdkQuery();
  internal.query = mockQuery as unknown as Query;
  // private 字段 cast 注入 — 与 sdk-bridge.consume-fork.test.ts 同款 cast 模式
  (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
    opts.sessionId,
    internal,
  );
  return { bridge, internal, mockQuery };
}

beforeEach(() => {
  emits.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase 3 Step 3.1 — setPermissionMode SDK throw 回滚 in-memory cache (A1-MED-1 claude)', () => {
  it('SDK setPermissionMode resolve → s.permissionMode = newMode (端到端 via 真 bridge)', async () => {
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-happy',
      initialMode: 'default',
    });
    const setPermissionModeSpy = vi.spyOn(mockQuery, 'setPermissionMode');

    await bridge.setPermissionMode('sid-happy', 'acceptEdits');

    expect(internal.permissionMode).toBe('acceptEdits');
    expect(setPermissionModeSpy).toHaveBeenCalledWith('acceptEdits');
  });

  it('SDK setPermissionMode throw → s.permissionMode 回滚到 oldMode + throw (端到端 via 真 bridge)', async () => {
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-throw',
      initialMode: 'plan',
    });
    // override mockQuery.setPermissionMode 让它抛错
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      throw new Error('SDK 切 mode 失败 (network / IPC error / CLI 死)');
    });

    let caught: Error | null = null;
    try {
      await bridge.setPermissionMode('sid-throw', 'bypassPermissions');
    } catch (err) {
      caught = err as Error;
    }

    expect(internal.permissionMode).toBe('plan'); // 回滚 oldMode
    expect(caught?.message).toContain('SDK 切 mode 失败');
  });

  it('连续切档,失败夹中间不污染后续成功 → cache 准确 (端到端 via 真 bridge)', async () => {
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-mixed',
      initialMode: 'default',
    });
    let counter = 0;
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      counter++;
      if (counter === 2) throw new Error('mid-fail');
    });

    // 第 1 次切到 acceptEdits 成功
    await bridge.setPermissionMode('sid-mixed', 'acceptEdits');
    expect(internal.permissionMode).toBe('acceptEdits');

    // 第 2 次切到 plan 失败 → 回滚 acceptEdits
    let secondCaught: Error | null = null;
    try {
      await bridge.setPermissionMode('sid-mixed', 'plan');
    } catch (err) {
      secondCaught = err as Error;
    }
    expect(secondCaught?.message).toContain('mid-fail');
    expect(internal.permissionMode).toBe('acceptEdits'); // 回滚不动到 plan

    // 第 3 次切到 bypassPermissions 成功
    await bridge.setPermissionMode('sid-mixed', 'bypassPermissions');
    expect(internal.permissionMode).toBe('bypassPermissions');
  });

  it('session 不在 sessions Map → throw "session ... not found" (真 bridge 行为)', async () => {
    const bridge = new ClaudeSdkBridge({ emit: (e) => emits.push(e) });
    await expect(bridge.setPermissionMode('ghost-sid', 'plan')).rejects.toThrow(
      /session ghost-sid not found/,
    );
  });
});

describe('Phase R3 fix-3 — per-session async lock 串行化 setPermissionMode（替代 Phase 2.7 seq counter）', () => {
  it('R3 fix-3: 同 session 并发 A 失败 + B 成功 → chain 串行化 → A catch rollback 后 B 入临界区拿真 oldMode → B 成功 cache=B mode', async () => {
    // Phase R3 fix-3 修法 (R3 codex Batch A HIGH-2)：替代 Phase 2.7 seq counter 为 chain 串行化。
    //
    // 串行化语义：A await 完成（成功或失败）后 B 才进入临界区，B oldMode 永远是 A catch
    // rollback 后的真值（无 race），无需 seq guard。
    //
    // 现 race 场景 (A 失败 + B 成功):
    //   1. A 入链 chain[0] await → A 失败 catch rollback s.permissionMode = 'default' (oldMode)
    //   2. chain[1] B 入临界区: oldMode = s.permissionMode = 'default'(A rollback 真值),
    //      s.permissionMode = 'plan' optimistic
    //   3. B SDK 成功 → s.permissionMode 留 'plan'
    //   最终 'plan' ✓
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-concurrent',
      initialMode: 'default',
    });

    let rejectA: ((err: Error) => void) | null = null;
    let resolveB: (() => void) | null = null;
    let callCount = 0;
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectA = reject as (err: Error) => void;
        });
      } else {
        return new Promise<void>((resolve) => {
          resolveB = resolve as () => void;
        });
      }
    });

    // 1. A 启动（不 await）
    const promiseA = bridge.setPermissionMode('sid-concurrent', 'plan');
    // chain 串行化：caller 同步只拿 Promise，临界区在 chain.then microtask 内跑。
    // microtask flush 后 A 入临界区 → optimistic 写 'plan'。
    await Promise.resolve();
    expect(internal.permissionMode).toBe('plan');

    // 2. B 启动 — chain 串行化让 B 卡在 chain[1].then 等 A 完成
    const promiseB = bridge.setPermissionMode('sid-concurrent', 'bypassPermissions');
    // 此时 B 还没入临界区，B 的 optimistic 还没写 — s.permissionMode 仍是 A 的 'plan'
    expect(internal.permissionMode).toBe('plan');
    // resolveB 还是 null（B mock 没被调，因为 A await 还没完成）
    expect(callCount).toBe(1);

    // 3. A 失败 throw → catch rollback s.permissionMode = oldMode = 'default'
    (rejectA as null | ((err: Error) => void))?.(new Error('A SDK throw'));
    let aCaught: Error | null = null;
    try {
      await promiseA;
    } catch (err) {
      aCaught = err as Error;
    }
    expect(aCaught?.message).toContain('A SDK throw');

    // 4. A 完成后 microtask flush 让 chain[1] B 入临界区
    // B mock 被调（callCount=2），B optimistic 写 'bypass'
    await Promise.resolve();
    expect(callCount).toBe(2);
    expect(internal.permissionMode).toBe('bypassPermissions');

    // 5. B 成功 resolve
    (resolveB as null | (() => void))?.();
    await promiseB;
    expect(internal.permissionMode).toBe('bypassPermissions');
  });

  it('R3 fix-3 核心 race 修复: 同 session 并发 A/B 都失败 → chain 串行化让 B oldMode 是 A rollback 真值 → 最终 cache 与 SDK 同步 (codex A HIGH-2)', async () => {
    // codex Batch A HIGH-2 描述 race 真根因：
    //   A: ++seq=1, oldMode='default', s.permissionMode='plan', await SDK 失败
    //   B (中间进入): ++seq=2, oldMode='plan'(A optimistic), s.permissionMode='bypass', await SDK 失败
    //   B catch: seq===2 === B.seq → s.permissionMode = oldMode = 'plan' (A 脏值)
    //   A catch: seq===2 !== A.seq(1) → 跳过回滚 → s.permissionMode 保留 'plan'
    //   最终 cache='plan' 但 SDK 实际仍'default' → cache 脏 → canUseTool 按脏 cache 判断 → 安全降级
    //
    // R3 fix-3 修法 = chain 串行化:
    //   1. A 入链 chain[0] await → A 失败 catch rollback s.permissionMode='default'
    //   2. chain[1] B 入临界区: oldMode=s.permissionMode='default' (A rollback 真值),
    //      s.permissionMode='bypass' optimistic
    //   3. B SDK 失败 catch rollback s.permissionMode='default'
    //   最终 cache='default' === SDK 真值 ✓ — cache 与 SDK 同步,无安全降级
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-dual-fail',
      initialMode: 'default',
    });

    let rejectA: ((err: Error) => void) | null = null;
    let rejectB: ((err: Error) => void) | null = null;
    let callCount = 0;
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectA = reject as (err: Error) => void;
        });
      } else {
        return new Promise<void>((_resolve, reject) => {
          rejectB = reject as (err: Error) => void;
        });
      }
    });

    // 1. A 启动 plan → microtask flush 后 A optimistic 写 'plan'
    const promiseA = bridge.setPermissionMode('sid-dual-fail', 'plan');
    await Promise.resolve();
    expect(internal.permissionMode).toBe('plan');

    // 2. B 启动 bypass — chain 串行化让 B 等 A 完成才入临界区
    const promiseB = bridge.setPermissionMode('sid-dual-fail', 'bypassPermissions');
    // B 还没入临界区
    expect(internal.permissionMode).toBe('plan');
    expect(callCount).toBe(1);

    // 3. A 失败 → catch rollback 到 'default'（A 的 oldMode）
    (rejectA as null | ((err: Error) => void))?.(new Error('A SDK throw'));
    let aCaught: Error | null = null;
    try {
      await promiseA;
    } catch (err) {
      aCaught = err as Error;
    }
    expect(aCaught?.message).toContain('A SDK throw');
    // 注：A reject 后 await promiseA 已经 microtask flush → chain[1] B 已入临界区
    // 写 'bypass' optimistic。此处不能断言 cache='default'（A rollback 真值已被 B
    // optimistic 覆盖）。但 B 入临界区时 oldMode 仍是 A rollback 后的真值 'default'，
    // 这就是 chain 串行化关键：B 看到的 oldMode 是 A 已 rollback 真值，不是 A 脏值。

    // 4. B 入临界区: oldMode='default'（A rollback 真值,不是 A 脏值 'plan'!）
    expect(callCount).toBe(2);
    expect(internal.permissionMode).toBe('bypassPermissions'); // B optimistic

    // 5. B 失败 → catch rollback 到 'default'（B 的 oldMode 是 A rollback 真值）
    (rejectB as null | ((err: Error) => void))?.(new Error('B SDK throw'));
    let bCaught: Error | null = null;
    try {
      await promiseB;
    } catch (err) {
      bCaught = err as Error;
    }
    expect(bCaught?.message).toContain('B SDK throw');

    // **核心 invariant (R3 fix-3 修法目标)**: 最终 cache='default' === SDK 真值（两次都失败,
    // SDK 实际仍 default）。无脏 cache → canUseTool 按真值判断 → 无安全降级。
    expect(internal.permissionMode).toBe('default');
  });

  it('R3 fix-3 chain 持久化: 一次失败后下次切档仍能继续工作（chain 内部 .catch 防链路打破）', async () => {
    // chain 内部 `.catch(() => undefined)` 吞 throw 防链路打破。caller 拿到的 promise 仍 reject
    // 真错，但 chain 不卡 reject — 下一次 caller 入链能正常 await prev 完成（视为 undefined）。
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-chain-persist',
      initialMode: 'default',
    });

    let callCount = 0;
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('first call fail');
      // 后续都成功
    });

    // 第 1 次失败
    let firstCaught: Error | null = null;
    try {
      await bridge.setPermissionMode('sid-chain-persist', 'plan');
    } catch (err) {
      firstCaught = err as Error;
    }
    expect(firstCaught?.message).toContain('first call fail');
    expect(internal.permissionMode).toBe('default'); // rollback

    // 第 2 次仍能正常切档（chain 没打破）
    await bridge.setPermissionMode('sid-chain-persist', 'acceptEdits');
    expect(internal.permissionMode).toBe('acceptEdits');

    // 第 3 次仍能正常切档
    await bridge.setPermissionMode('sid-chain-persist', 'bypassPermissions');
    expect(internal.permissionMode).toBe('bypassPermissions');
  });

  it('R3 fix-3 per-session chain 隔离: A session 切档不影响 B session 串行化', async () => {
    // R2 plan-review MED-F invariant 延续：chain 是 per-session 字段（不是 bridge 全局），
    // A 与 B session 各自有独立 chain，跨 session 不互相 block。
    const { bridge, internal: a } = setupBridgeWithSession({
      sessionId: 'sid-A',
      initialMode: 'default',
    });
    const internalB = makeInternalSession({ cwd: '/tmp/test-B', permissionMode: 'default', applicationSid: 'sess-test-B' });
    const mockQueryB = new MockSdkQuery();
    internalB.query = mockQueryB as unknown as Query;
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'sid-B',
      internalB,
    );

    expect(a.permissionModeChain).toBeUndefined();
    expect(internalB.permissionModeChain).toBeUndefined();

    // A 切档成功
    await bridge.setPermissionMode('sid-A', 'plan');
    expect(a.permissionMode).toBe('plan');
    expect(a.permissionModeChain).not.toBeUndefined(); // A chain 已设
    expect(internalB.permissionModeChain).toBeUndefined(); // B chain 仍未触

    // B 切档成功
    await bridge.setPermissionMode('sid-B', 'acceptEdits');
    expect(internalB.permissionMode).toBe('acceptEdits');
    expect(internalB.permissionModeChain).not.toBeUndefined();

    // 两个 session 各自 mode 独立
    expect(a.permissionMode).toBe('plan');
    expect(internalB.permissionMode).toBe('acceptEdits');
  });
});
