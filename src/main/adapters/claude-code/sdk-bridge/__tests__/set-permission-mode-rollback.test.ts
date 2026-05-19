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

describe('Phase 2.7 — per-session seq guard 防并发回滚污染（已 land 验证）', () => {
  it('同 session same-mode 并发: A 设 plan 失败 + B 设 plan 成功 → A catch 因 seq 推进不回滚 → cache 保留 B 成功 mode', async () => {
    // Phase 2.7 修法 (R3 plan-review codex MED-2)：per-session seq counter 防 race。
    //
    // race 真根因：setPermissionMode 无锁 async；同 session same-mode 并发：
    //   A 设 plan await → B 设 plan await SDK 成功 → A SDK 失败 catch 当前=plan
    //   按「当前值 guard」错误回滚成 default 把 B 已成功 plan 改回去（B 实际 SDK 已切到 plan，
    //   应用 cache 却被 A catch 错误降回 default → cache vs SDK 不同步）。
    //
    // 修法 = per-session seq counter (InternalSession.permissionModeSeq)：
    //   入口 ++seq；catch 内仅当 s.permissionModeSeq === seq (无后续推进) 才回滚
    const { bridge, internal, mockQuery } = setupBridgeWithSession({
      sessionId: 'sid-concurrent',
      initialMode: 'default',
    });
    expect(internal.permissionModeSeq).toBe(0);

    // 控制 SDK setPermissionMode 行为：第 1 次延迟 throw，第 2 次立即 resolve
    // 用 deferred resolver 让 caller 控制时序
    let resolveB: (() => void) | null = null;
    let rejectA: ((err: Error) => void) | null = null;
    let callCount = 0;
    vi.spyOn(mockQuery, 'setPermissionMode').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // A: 等 B 完成后才 throw
        return new Promise<void>((_resolve, reject) => {
          rejectA = reject as (err: Error) => void;
        });
      } else {
        // B: 等待 caller manually resolve
        return new Promise<void>((resolve) => {
          resolveB = resolve as () => void;
        });
      }
    });

    // 1. A 启动 setPermissionMode('plan')（不 await，模拟并发 A 在等 SDK）
    const promiseA = bridge.setPermissionMode('sid-concurrent', 'plan');
    // A 入口 ++seq → 1，s.permissionMode = 'plan'
    expect(internal.permissionModeSeq).toBe(1);
    expect(internal.permissionMode).toBe('plan');

    // 2. B 启动 setPermissionMode('plan')（同 mode 并发）
    const promiseB = bridge.setPermissionMode('sid-concurrent', 'plan');
    // B 入口 ++seq → 2，s.permissionMode 仍 'plan'（同 mode）
    expect(internal.permissionModeSeq).toBe(2);
    expect(internal.permissionMode).toBe('plan');

    // 3. B 先成功 resolve
    (resolveB as null | (() => void))?.();
    await promiseB; // B happy
    expect(internal.permissionMode).toBe('plan'); // B 成功 → cache 保持 plan

    // 4. A 后失败 throw
    (rejectA as null | ((err: Error) => void))?.(new Error('A SDK throw after B succeeded'));
    let aCaught: Error | null = null;
    try {
      await promiseA;
    } catch (err) {
      aCaught = err as Error;
    }
    expect(aCaught?.message).toContain('A SDK throw');

    // **核心 invariant**：A catch 看到 s.permissionModeSeq === 2 ≠ A 自己的 seq=1
    // → A catch 不回滚（B 已推进 seq）→ cache 仍是 B 已成功的 'plan'，不被错误降回 'default'
    expect(internal.permissionMode).toBe('plan');
    expect(internal.permissionModeSeq).toBe(2); // 双方都推进过 seq
  });

  it('per-session seq counter 隔离：A session + B session 并发不互相干扰', async () => {
    // R2 plan-review MED-F：不能用 bridge 全局 seq — 跨 session race 干扰。本 case 验证
    // permissionModeSeq 是 per-session 字段（不是 bridge 全局），A 与 B session 各自计数。
    const { bridge, internal: a } = setupBridgeWithSession({
      sessionId: 'sid-A',
      initialMode: 'default',
    });
    const internalB = makeInternalSession({ cwd: '/tmp/test-B', permissionMode: 'default' });
    const mockQueryB = new MockSdkQuery();
    internalB.query = mockQueryB as unknown as Query;
    (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions.set(
      'sid-B',
      internalB,
    );

    expect(a.permissionModeSeq).toBe(0);
    expect(internalB.permissionModeSeq).toBe(0);

    // A 切档成功
    await bridge.setPermissionMode('sid-A', 'plan');
    expect(a.permissionModeSeq).toBe(1);
    expect(internalB.permissionModeSeq).toBe(0); // B 不受影响

    // B 切档成功
    await bridge.setPermissionMode('sid-B', 'acceptEdits');
    expect(a.permissionModeSeq).toBe(1); // A 不受影响
    expect(internalB.permissionModeSeq).toBe(1);
  });
});
