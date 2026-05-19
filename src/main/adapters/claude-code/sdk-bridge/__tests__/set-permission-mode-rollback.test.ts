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

describe('Phase 2.7 (待 land) — per-session seq guard 防并发回滚污染', () => {
  it.skip(
    '同 session same-mode 并发: A 设 plan 失败 + B 设 plan 成功 → A catch 因 seq 推进不回滚 (Phase 2.7 修法待 land 后 unskip)',
    async () => {
      // Phase 2.7 修法 (R3 plan-review codex MED-2)：setPermissionMode 无锁 async；同 session
      // same-mode 并发场景：A 设 plan await → B 设 plan await SDK 成功 → A SDK 失败 catch 当前=plan
      // 按「当前值 guard」错误回滚成 default 把 B 已成功 plan 改回去。
      //
      // 修法 = per-session seq counter：
      //   InternalSession.permissionModeSeq: number (默认 0)
      //   setPermissionMode 入口 ++seq；catch 内仅当 s.permissionModeSeq === seq (无后续推进) 才回滚
      //
      // Phase 2.7 land 后 unskip + 实现 case：
      // 1. setupBridgeWithSession initialMode='default'
      // 2. mock setPermissionMode 让第 1 次 throw, 第 2 次 resolve
      // 3. 并发 await bridge.setPermissionMode('sid', 'plan') × 2 (concurrent)
      // 4. assert: 1 次成功 + 1 次 throw + internal.permissionMode === 'plan' (B 成功值,不被 A catch 错误回滚 default)
      // 5. assert: internal.permissionModeSeq === 2 (per-session 计数,两次都推进 seq)
    },
  );
});
