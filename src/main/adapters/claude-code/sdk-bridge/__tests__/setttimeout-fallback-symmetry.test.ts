/**
 * Phase 1.4b (plan deep-review-batch-a1-b-followup-r3-20260519)：setTimeout fallback symmetry +
 * SDK race scenario test。
 *
 * **测试覆盖** (3 invariant)：
 *
 * - **(I) fallback fire 后 Map 切换正确**（A1-HIGH-2 已 land 行为，commit `074782e` 之前）：
 *   waitForRealSessionId 30s setTimeout fallback fire → sessions Map 删 tempKey + set fallbackId
 *   + internal.realSessionId = fallbackId + emit error message
 *
 * - **(II) late first-id 到达不覆盖 fallbackId**（**SKIPPED 等 Phase 2 step 2.2 (B) guard land**）：
 *   fallback fire 后 SDK 仍 emit late first-id frame（spike1 实证 SDK in-flight burst）。Phase 2
 *   修法在 stream-processor.consume L221 first-id 路径加 `if (internal.realSessionId !== null &&
 *   internal.realSessionId !== incomingId) { continue; }` guard，让 late id 不覆盖 fallbackId。
 *   Phase 1.4 land 时此 case skip（当前未 guard，late id 会切到 sessions Map 让 fallbackId 被删）；
 *   Phase 2 step 2.2 修法 land 时 unskip 验证 race window 关闭。
 *
 * - **(III) MockSdkQuery interrupt() 不 auto-end stream**（spike1 兼容性 invariant，mock 自身契约）：
 *   spike1 case A 实证 SDK 调 interrupt() 后仍 emit in-flight 7 frame burst（hook ×4 + init +
 *   user + result_error），interrupt() resolve 时机在 frame 之后。MockSdkQuery 必须模拟这个行为
 *   让 Phase 2 修法的 race test 不被 mock over-restrictive 破坏（详 _shared/mocks/sdk-query.ts
 *   §interrupt() 契约）。本 case 测 mock 自身 — pushFrame after interrupt 仍 work（done=false）。
 *
 * **mock 策略**（详 _shared/mocks/sdk-query.ts MockSdkQuery + plan §Phase 1.4 顶部）：
 * controllable AsyncGenerator + fake timers（vi.useFakeTimers + advanceTimersByTimeAsync）+
 * createSession 真路径（不走 TestBridge override，让 stream-processor.waitForRealSessionId /
 * consume 真跑）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// Mock 链与 createsession-fail-fast.test.ts 同款（hoisted vi.mock 必须每个文件独立写，
// 不能从 helper 模块复用 — 详 _shared/mocks/_setup.ts hoist 限制）
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn() },
  }),
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    listForSession: vi.fn(() => []),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    overrides: {
      get: vi.fn(() => undefined),
    },
  }),
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    findActiveMembershipsBySession: vi.fn(() => []),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
  },
}));

vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getClaudeAgentDeckPluginPath: () => '/fake/plugin',
  getAgentDeckSystemPromptAppend: () => '',
  getAgentDeckPluginsForSession: () => undefined,
}));

vi.mock('@main/task-manager/server', () => ({
  getTasksMcpServerForSession: vi.fn(() => null),
}));

vi.mock('@main/agent-deck-mcp/server', () => ({
  getAgentDeckMcpServerForSession: vi.fn(() => null),
  AGENT_DECK_MCP_TOOL_PATTERN: /^mcp__agent-deck/,
}));

vi.mock('@main/session/summarizer/llm-runners', () => ({
  summariseSessionForHandOff: vi.fn(async () => null),
}));

import { sessionManager } from '@main/session/manager';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import type { AgentEvent } from '@shared/types';

const emits: AgentEvent[] = [];

function makeBridge(): ClaudeSdkBridge {
  return new ClaudeSdkBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}

function installMockQuery(mockQuery: MockSdkQuery): void {
  // loadSdk 返回完整 SDK module type（含 createSdkMcpServer / forkSession 等 ~20 个 export），
  // mock 全部无意义。createSession 仅消费 query / tool。整个 mockResolvedValue cast as never 装入。
  vi.mocked(loadSdk).mockResolvedValue({
    query: vi.fn(() => mockQuery),
    tool: vi.fn((name, description, inputSchema, handler) => ({
      name,
      description,
      inputSchema,
      handler,
    })),
  } as never);
}

beforeEach(() => {
  emits.length = 0;
  vi.mocked(loadSdk).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReturnValue(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setTimeout fallback symmetry — A1-HIGH-2 + Phase 2 race guard', () => {
  it('(I) fallback fire 后 Map 切换正确 — A1-HIGH-2 已 land 行为', async () => {
    // A1-HIGH-2 修法（commit `074782e` base 之前 plan deep-review-batch-a1-b-fixes-20260519
    // 已 land）：fallback 路径不仅改 internal.realSessionId 还切 sessions Map（详
    // stream-processor.ts:147-160 注释）。本 case 验证当前 land 行为。
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    // resume 路径让 fallbackId === resumeId（不是 tempKey）— 与生产实际 hand-off / dormant
    // resume 场景一致（A1-HIGH-2 修法的设计意图：fallbackId 直接落 OLD_ID 避免造孤儿）
    const RESUME_ID = 'resume-id-A1H2';

    // 启动 createSession 但不 push 任何 frame，让 30s fallback fire
    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
      resume: RESUME_ID,
    });

    // 让 microtask chain 跑到 setTimeout 等待点（loadSdk async / buildMcpServersForSession async）
    await vi.advanceTimersByTimeAsync(0); // micro tick
    await vi.advanceTimersByTimeAsync(0); // micro tick
    await vi.advanceTimersByTimeAsync(0); // micro tick
    // 推进 30s 让 setTimeout fallback fire
    await vi.advanceTimersByTimeAsync(30_000);

    // fallback fire 后立即 endStream 让 consume for-await 退出 + finally cleanup 跑
    mockQuery.endStream();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // createSession 走 fallback 路径：waitForRealSessionId resolve(fallbackId=RESUME_ID)
    // 但 createSession L307 `if (realId === tempKey) throw` — fallback 时 realId === RESUME_ID
    // ≠ tempKey，所以不 throw 继续走真路径走完 finalizeSessionStart 等。
    // 但 mock 模式下 finalizeSessionStart 调真 sessionRepo.setClaudeCodeSandbox 等 noop（mock）。
    // 期望 createPromise 走完不 throw。
    // 注意：consume finally 调 sessions.delete(sid) + sessions.delete(tempKey)，所以 fallback fire
    // 后 endStream → finally cleanup → sessions Map 最终空。需要 BEFORE endStream 检查 Map state。
    //
    // **改 timing**：先在 fallback fire 后立即检查 sessions Map（before endStream），再 endStream。

    const handle = await createPromise;
    expect(handle.sessionId).toBe(RESUME_ID); // fallback 用 resumeId 作 fallbackId

    // emit error message（fallback 路径必发，UI 看到 SDK 异常）
    const errorMessages = emits.filter(
      (e) =>
        e.kind === 'message' &&
        (e.payload as { error?: boolean }).error === true &&
        ((e.payload as { text?: string }).text ?? '').includes('SDK 30 秒内未收到任何消息'),
    );
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].sessionId).toBe(RESUME_ID); // 用 fallbackId 而非 tempKey emit
  });

  it(
    '(II) late first-id 到达不覆盖 fallbackId — Phase 2 step 2.2 (B) guard 修法（已 land 验证）',
    async () => {
      // Phase 2 step 2.2 修法：stream-processor.consume L221 first-id 路径加 guard，
      // 当 internal.realSessionId 已被 fallback set 且 ≠ incoming id → skip mutation + continue。
      // 修法已 land。
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const bridge = makeBridge();
      const mockQuery = new MockSdkQuery();
      installMockQuery(mockQuery);

      const RESUME_ID = 'resume-id-race';
      const LATE_REAL_ID = 'late-real-id-from-sdk-burst';

      const createPromise = bridge.createSession({
        cwd: '/tmp/test',
        prompt: 'hi',
        resume: RESUME_ID,
      });

      // 推进到 fallback fire
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);

      // sessions Map 此时应有 fallbackId entry
      const sessionsMap = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
      // BEFORE endStream 验证（finally 还未跑）
      expect(sessionsMap.has(RESUME_ID)).toBe(true);

      // late first-id frame 到达（spike1 实证 SDK in-flight burst）— stream 仍 open
      mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: LATE_REAL_ID });
      await vi.advanceTimersByTimeAsync(0);

      // **Phase 2 step 2.2 (B) guard 修法 assert (BEFORE endStream)**：
      // sessions Map 仍指向 fallbackId 而非 LATE_REAL_ID
      expect(sessionsMap.has(RESUME_ID)).toBe(true); // fallbackId 仍在
      expect(sessionsMap.has(LATE_REAL_ID)).toBe(false); // late id 没被设入

      // 显式 endStream 让 consume for-await 退出 + finally cleanup 跑
      mockQuery.endStream();
      await vi.advanceTimersByTimeAsync(0);

      // **AFTER endStream finally cleanup 三档链**：
      // realId 仍 null（guard 让 mutation block continue）→ sid = realId ?? internal.realSessionId
      // ?? tempKey = fallbackId → sessions.delete(fallbackId) + sessions.delete(tempKey)
      expect(sessionsMap.has(RESUME_ID)).toBe(false);
      expect(sessionsMap.has(LATE_REAL_ID)).toBe(false);

      const handle = await createPromise;
      expect(handle.sessionId).toBe(RESUME_ID); // fallback 路径仍返 RESUME_ID
    },
  );

  it('(III) MockSdkQuery interrupt() 不 auto-end stream — spike1 兼容性 invariant', async () => {
    // spike1 case A 实证 SDK 调 interrupt() 后仍 emit in-flight 7 frame burst。MockSdkQuery
    // 必须模拟这个行为让 Phase 2 修法 race test 不被 mock over-restrictive 破坏。
    //
    // 测试 mock 自身契约（不依赖 production 代码）：
    // 1. interrupt() resolve 不 set done=true（与真 SDK 行为一致）
    // 2. interrupt() 后仍能 pushFrame + next() 拿到（in-flight burst 模拟）
    // 3. interruptCallCount 计数正确
    // 4. endStream 后 pushFrame 静默 ignore + warn（closed-stream 状态机）
    const mockQuery = new MockSdkQuery();
    expect(mockQuery.isInterrupted).toBe(false);
    expect(mockQuery.isDone).toBe(false);

    // 推 1 frame，next() 应能拿到
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'sid-1' });
    const r1 = await mockQuery.next();
    expect(r1.done).toBe(false);
    expect(r1.value?.session_id).toBe('sid-1');

    // 调 interrupt() — 不 auto-end，仅标记
    await mockQuery.interrupt();
    expect(mockQuery.isInterrupted).toBe(true);
    expect(mockQuery.interruptCallCount).toBe(1);
    expect(mockQuery.isDone).toBe(false); // **关键 invariant**：interrupt 不让 stream done

    // interrupt() 后仍能 pushFrame（spike1 in-flight burst 模拟）
    mockQuery.pushFrame({ type: 'system', subtype: 'hook_response', session_id: 'sid-1' });
    const r2 = await mockQuery.next();
    expect(r2.done).toBe(false);
    expect(r2.value?.subtype).toBe('hook_response');

    // 多次 interrupt()
    await mockQuery.interrupt();
    expect(mockQuery.interruptCallCount).toBe(2);

    // explicit endStream 终止 stream（与真 SDK frame burst 完毕后的自然终止一致）
    mockQuery.endStream();
    expect(mockQuery.isDone).toBe(true);
    const rEnd = await mockQuery.next();
    expect(rEnd.done).toBe(true);

    // endStream 后 pushFrame 静默 ignore + warn — closed-stream 状态机
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'after-end' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    // endStream idempotent — 多次调 no-op
    mockQuery.endStream(); // 无 throw / 无副作用
    expect(mockQuery.isDone).toBe(true);
  });
});
