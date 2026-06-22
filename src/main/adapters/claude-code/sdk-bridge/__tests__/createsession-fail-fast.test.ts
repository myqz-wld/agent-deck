/**
 * Phase 1.4a (plan deep-review-batch-a1-b-followup-r3-20260519)：A1-HIGH-1 失败语义 test。
 *
 * **A1-HIGH-1**（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）：旧 impl
 * waitForRealSessionId 在 SDK 流终止但从未发 first session_id frame 时 resolve(realId ?? tempKey)
 * = tempKey。createSession 继续走 finalizeSessionStart 创建一条 sessionId=tempKey 的假 DB record
 * （无 SDK live state）+ opts.resume 的 sdkOwned claim 永不释放（OLD_ID 后续 hook 事件被静默
 * 吞 = leak）。修法 (A) 彻底失败语义：realId === tempKey → throw 让 createSession 进 catch L317
 * 走完整 cleanup（sessions.delete + releasePending + releaseSdkClaim(opts.resume) + throw IPC）。
 *
 * **测试覆盖**:
 * - **happy 失败路径**（commit `034efea` 上 plan deep-review-batch-a1-b-fixes-20260519 已 land）：
 *   mock SDK 1 frame 无 session_id → createSession throw + sessions.delete(tempKey) +
 *   releasePending + releaseSdkClaim(opts.resume) 全部触发
 * - **resume 路径**：opts.resume 传入 → catch 内 sessionManager.releaseSdkClaim(opts.resume) 调
 * - **non-resume 路径**：opts.resume 不传 → catch 不调 releaseSdkClaim
 * - **catch 内 fire-and-forget interrupt**（**SKIPPED 等 Phase 2 step 2.5 land**）：catch 块入口
 *   立刻 set `internal.expectedClose = true; void internal.query?.interrupt?.()` 防 detached SDK
 *   子进程继续跑 LLM 调用 + 防 SDK in-flight first-id frame 撞 Phase 2 step 2.2 (B) guard。
 *   Phase 2.5 修法 land 时 unskip 本 case 验证。
 *
 * **mock 策略**（详 _shared/mocks/sdk-query.ts MockSdkQuery jsdoc）：
 * controllable AsyncGenerator + push 1 frame 无 session_id + endStream → consume return null →
 * waitForRealSessionId resolve(tempKey) → createSession `if (realId === tempKey) throw`。
 * 不需要 fake timers，stream 同步终止快路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// R37 P2-F Step 3.1：sessionRepo / sdk-loader / settings-store / sessionManager 全 mock
// 与 sdk-bridge.recovery.test.ts 同款。
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
    updateCliSessionId: vi.fn(),
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

/**
 * Helper：mock loadSdk 返回的 query factory，让其返回受控 MockSdkQuery。
 * caller 可 push frame / endStream 控制 SDK Query 行为。
 *
 * 类型 cast：MockSdkQuery 仅 mock SDK Query 的最小 surface（next/return/throw/interrupt/
 * setPermissionMode/[Symbol.asyncIterator]）；SDK Query 完整 interface 含 ~20 个 control
 * request method（setModel / applyFlagSettings 等）mock 无意义，用 `as unknown as` 装入。
 */
function installMockQuery(mockQuery: MockSdkQuery): void {
  // loadSdk 返回完整 SDK module type（含 createSdkMcpServer / forkSession 等 ~20 个 export），
  // mock 全部 无意义。createSession 仅消费 query / tool。整个 mockResolvedValue cast as never 装入。
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
  vi.mocked(sessionManager.expectSdkSession).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReturnValue(() => undefined);
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.updateCliSessionId).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSession A1-HIGH-1 失败语义 — SDK 流终止前没 emit first session_id frame', () => {
  it('non-resume 路径：mock SDK 1 frame 无 session_id + endStream → createSession throw + sessions Map empty + releasePending', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);
    // releasePending mock 让本 case 能 assert 被 release
    const releaseSpy = vi.fn();
    vi.mocked(sessionManager.expectSdkSession).mockReturnValue(releaseSpy);

    // SDK 推 1 frame 无 session_id（typical: 早期 hook_started 在 first id 之前的 burst 也可能没带 sid，
    // 但实测一般有；这里直接构造无 sid frame 触发失败路径）+ endStream 让 for-await 退出
    mockQuery.pushFrame({ type: 'system', subtype: 'hook_started' }); // 无 session_id
    mockQuery.endStream();

    await expect(
      bridge.createSession({ cwd: '/tmp/test', prompt: 'hi', awaitCanonicalId: true }),
    ).rejects.toThrow(/SDK stream ended without emitting first session_id frame/);

    // catch 块 cleanup 全部触发
    // 1. sessions Map 空（finally 已 sessions.delete(sid=tempKey) + sessions.delete(tempKey)；catch 也 sessions.delete(tempKey)）
    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.size).toBe(0);
    // 2. releasePending 触发（catch 内调）
    expect(releaseSpy).toHaveBeenCalled();
    // 3. opts.resume 没传 → releaseSdkClaim 不调（**catch 内的** resume 释放路径不走；
    //    但 finally cleanup 的 sessionManager.releaseSdkClaim(sid) 仍会调一次，sid=tempKey）
    //    所以 releaseSdkClaim 可能调 1 次（finally with tempKey）；不应调 opts.resume
    const releaseSdkCalls = vi.mocked(sessionManager.releaseSdkClaim).mock.calls;
    // finally cleanup 调 release(tempKey) — 是 UUID 格式（randomUUID），不是固定值；只断言不调任何 resume id
    // 实际上 non-resume 路径 opts.resume undefined，catch L323 `if (opts.resume)` 短路 → 不调
    // finally 调 release(sid=realId??tempKey=tempKey)；release 调 1 次 OK
    expect(releaseSdkCalls.length).toBeLessThanOrEqual(1);
  });

  it('resume 路径：opts.resume 传入 → catch 内 releaseSdkClaim(opts.resume) 调', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);
    const releaseSpy = vi.fn();
    vi.mocked(sessionManager.expectSdkSession).mockReturnValue(releaseSpy);

    // resume 路径下：createSession 进入时 claimAsSdk(opts.resume) 先调；
    // 失败时 catch 释放（CHANGELOG_47 修法）+ finally 也释放（sid=fallbackId=resumeId）
    mockQuery.pushFrame({ type: 'system', subtype: 'hook_started' }); // 无 session_id
    mockQuery.endStream();

    await expect(
      bridge.createSession({ cwd: '/tmp/test', prompt: 'hi', resume: 'OLD-ID' }),
    ).rejects.toThrow(/SDK stream ended without emitting first session_id frame/);

    // catch L323 `if (opts.resume) sessionManager.releaseSdkClaim(opts.resume)` 调
    const releaseSdkCalls = vi.mocked(sessionManager.releaseSdkClaim).mock.calls;
    const releasedIds = releaseSdkCalls.map((c) => c[0]);
    expect(releasedIds).toContain('OLD-ID');
  });

  it('happy canonical: createSession 正常拿到 first session_id → 不 throw + 返回 realId', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    // 推 first id frame 让 consume 走 first-id 路径
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'real-sid-123' });
    // 不 endStream，让 createSession 拿到 realId 后 return (waitForRealSessionId resolve)
    // 但实际 createSession 走完 waitForRealSessionId 后会继续往下跑 finalizeSessionStart 等
    // 真路径，需要等 consume 真终止 sessions Map 才被清。本 case 仅断言 throw 路径不撞，
    // 不强 assert sessions Map state（finalize 路径调真 sessionRepo / emit 等可能 noop 不影响）
    // 用 setImmediate 让 waitForRealSessionId 拿到 first id 后 resolve，再 endStream 让 consume 退出

    // 启动 createSession (不 await，让 it 异步 race)
    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
      awaitCanonicalId: true,
    });

    // 让微任务跑（让 consume push first id 进 waitForRealSessionId resolve）
    await new Promise((r) => setImmediate(r));

    // 现在 endStream 让 consume 完整结束
    mockQuery.endStream();

    // createSession 应该 resolve 而非 reject（拿到了 realId）
    const handle = await createPromise;
    expect(handle.sessionId).toBe('real-sid-123');
  });

  it('default new session fast-return：先返回 temp id，后台 first-id 后 rename 且不重复首条事件', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'real-fast-sid' });

    const handle = await bridge.createSession({ cwd: '/tmp/test', prompt: 'hi' });
    expect(handle.sessionId).not.toBe('real-fast-sid');

    const initialStarts = emits.filter((e) => e.kind === 'session-start');
    const initialUserMessages = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(initialStarts).toHaveLength(1);
    expect(initialStarts[0].sessionId).toBe(handle.sessionId);
    expect(initialUserMessages).toHaveLength(1);
    expect(initialUserMessages[0].sessionId).toBe(handle.sessionId);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(sessionManager.renameSdkSession)).toHaveBeenCalledWith(
      handle.sessionId,
      'real-fast-sid',
    );
    expect(vi.mocked(sessionManager.updateCliSessionId)).toHaveBeenCalledWith(
      'real-fast-sid',
      'real-fast-sid',
    );
    expect(emits.filter((e) => e.kind === 'session-start')).toHaveLength(1);
    expect(
      emits.filter(
        (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(1);

    mockQuery.endStream();
  });

  // **REVIEW_49 R1 follow-up 回归 test (F-MED)**: session-finalize.ts:98 改走
  // sessionManager.updateCliSessionId wrapper(R2 fix-F)统一黑名单链 SSOT — 防御未来若有
  // caller 误传不同 cliSessionId 时静默跳过黑名单写入。spawn 主路径下 oldCliSid ===
  // applicationSid === newCliSessionId,wrapper 内 L632 不写黑名单语义等价直调 sessionRepo
  // (短路 by-design),但调用面必须走 wrapper SSOT。
  it('REVIEW_49 R1 follow-up: spawn happy 路径调 sessionManager.updateCliSessionId wrapper (非 sessionRepo 直调)', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'spawn-sid-456' });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
      awaitCanonicalId: true,
    });
    await new Promise((r) => setImmediate(r));
    mockQuery.endStream();

    await createPromise;

    // **关键断言**: session-finalize.ts L98 走 wrapper 而非直调 sessionRepo
    expect(vi.mocked(sessionManager.updateCliSessionId)).toHaveBeenCalledWith(
      'spawn-sid-456',
      'spawn-sid-456',
    );
    // spawn 主路径 oldCliSid === applicationSid === newCliSessionId,语义等价直调 sessionRepo,
    // 但走 wrapper 让 SSOT 不被绕过(防未来 fork 路径误传不同 cliSessionId 静默跳过黑名单)
  });

  it(
    'Phase 2.5 修法：catch 内 fire-and-forget interrupt + set expectedClose（已 land 验证）',
    async () => {
      // Phase 2 step 2.5 修法 land：catch 块入口立刻 set `internal.expectedClose = true; if
      // (!internal.interruptFired) { internal.interruptFired = true; void internal.query?.interrupt?.(); }`
      // 然后 throw。
      const bridge = makeBridge();
      const mockQuery = new MockSdkQuery();
      installMockQuery(mockQuery);

      mockQuery.pushFrame({ type: 'system', subtype: 'hook_started' });
      mockQuery.endStream();

      await expect(
        bridge.createSession({ cwd: '/tmp/test', prompt: 'hi', awaitCanonicalId: true }),
      ).rejects.toThrow();

      // Phase 2.5 修法 assert：catch 触发 fire-and-forget interrupt 一次
      expect(mockQuery.interruptCallCount).toBe(1);

      // bridge.sessions 在 catch 内 sessions.delete(tempKey) → 空 — internal 不再可访问。
      // internal.expectedClose / internal.interruptFired 是设置在 GC 前的 internal session 上,
      // 直接 assert mockQuery.interruptCallCount === 1 已够间接验证 (interruptFired guard 通过
      // 才会调 interrupt(), 通过 interruptCallCount 反推 flag 与 expectedClose 都被 set)。
      const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
      expect(sessions.size).toBe(0); // catch 已 sessions.delete(tempKey)
    },
  );
});
