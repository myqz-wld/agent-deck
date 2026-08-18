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
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
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
  getAgentDeckSystemPromptAppend: () => '',
  getAgentDeckPluginsForSession: (selectedPluginDir?: string) =>
    selectedPluginDir ? [{ type: 'local', path: selectedPluginDir }] : undefined,
}));

vi.mock('@main/agent-deck-mcp/server', () => ({
  getAgentDeckMcpServerForSession: vi.fn(() => null),
  AGENT_DECK_MCP_TOOL_PATTERN: /^mcp__agent-deck/,
}));

import { sessionManager } from '@main/session/manager';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { desktopClaudeSessionDefaultsHost } from '@main/adapters/claude-code/sdk-bridge/session-defaults-host';
import { desktopClaudeRestartSessionHost } from '@main/adapters/claude-code/sdk-bridge/restart-session-host';
import { desktopClaudeRecoveryFreshnessHost } from '@main/adapters/claude-code/sdk-bridge/recovery-freshness-host';
import { desktopSessionModelControllerHost } from '@main/adapters/session-model-controller-host';
import { desktopClaudeJsonlDiscoveryHost } from '@main/adapters/claude-code/sdk-bridge/recoverer/jsonl-discovery-host';
import { createDesktopClaudeUsageSnapshotHost } from '@main/adapters/claude-code/usage-snapshot-host';
import { desktopClaudePermissionResponderHost } from '@main/adapters/claude-code/sdk-bridge/permission-responder-host';
import { desktopClaudeCwdTransitionHost } from '@main/adapters/claude-code/sdk-bridge/cwd-transition-controller-host';
import { desktopClaudeMessageControllerHost } from '@main/adapters/claude-code/sdk-bridge/message-controller-host';
import { createDesktopClaudeSessionLifecycleHost } from '@main/adapters/claude-code/sdk-bridge/session-lifecycle-host';
import { desktopClaudePendingOutgoingHost } from '@main/adapters/claude-code/sdk-bridge/pending-outgoing-host';
import { createDesktopClaudeStreamProcessorHost } from '@main/adapters/claude-code/sdk-bridge/stream-processor-host';
import { createDesktopClaudeSessionFinalizeHost } from '@main/adapters/claude-code/sdk-bridge/session-finalize-host';
import type { ClaudeSessionFinalizeHost } from '@main/adapters/claude-code/sdk-bridge/session-finalize-core';
import { desktopClaudeCanUseToolHost } from '@main/adapters/claude-code/sdk-bridge/can-use-tool-host';
import type { ClaudeCanUseToolHost } from '@main/adapters/claude-code/sdk-bridge/can-use-tool-core';
import { desktopClaudeCreateSessionSdkQueryHost } from '@main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-host';
import type { ClaudeCreateSessionSdkQueryHost } from '@main/adapters/claude-code/sdk-bridge/create-session/create-session-sdk-query-core';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import { sessionRepo } from '@main/store/session-repo';
import type { AgentEvent } from '@shared/types';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';

const emits: AgentEvent[] = [];

function makeBridge(overrides: {
  sessionFinalizeHost?: ClaudeSessionFinalizeHost;
  canUseToolHost?: ClaudeCanUseToolHost;
  createSessionSdkQueryHost?: ClaudeCreateSessionSdkQueryHost;
} = {}): ClaudeSdkBridge {
  return new ClaudeSdkBridge({
    createSessionHost: desktopClaudeSessionDefaultsHost,
    jsonlDiscoveryHost: desktopClaudeJsonlDiscoveryHost,
    recoveryFreshnessHost: desktopClaudeRecoveryFreshnessHost,
    restartSessionHost: desktopClaudeRestartSessionHost,
    sessionModelHost: desktopSessionModelControllerHost,
    usageSnapshotHost: createDesktopClaudeUsageSnapshotHost(sessionManager),
    permissionResponderHost: desktopClaudePermissionResponderHost,
    cwdTransitionHost: desktopClaudeCwdTransitionHost,
    messageControllerHost: desktopClaudeMessageControllerHost,
    sessionLifecycleHost: createDesktopClaudeSessionLifecycleHost(sessionManager),
    pendingOutgoingHost: desktopClaudePendingOutgoingHost,
    streamProcessorHost: createDesktopClaudeStreamProcessorHost(sessionManager),
    sessionFinalizeHost:
      overrides.sessionFinalizeHost ?? createDesktopClaudeSessionFinalizeHost(sessionManager),
    canUseToolHost: overrides.canUseToolHost ?? desktopClaudeCanUseToolHost,
    createSessionSdkQueryHost:
      overrides.createSessionSdkQueryHost ?? desktopClaudeCreateSessionSdkQueryHost,
    sessionManager,
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

function trustedRecoveryTurn() {
  const prepared: PreparedContinuationContext = {
    version: 2,
    providerPrompt: 'FULL TRUSTED RECOVERY CONTEXT',
    persistedUserText: 'continue recovery',
    source: { eventRevision: 9, rebuildAfterRevision: 0, maxEventId: 9 },
    checkpoint: { id: 4, throughRevision: 9, formatVersion: 2, refreshed: false },
    projection: { canonicalHash: 'canonical', omittedFacts: 0 },
    quality: 'full',
    metrics: {
      rawRetentionCeilingTokens: 64_000, targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000, generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100, checkpointTokens: 20, rawTailTokens: 20,
      includedUserMessages: 1, truncatedBoundaryMessages: 0,
      foldCalls: 1, repairCalls: 0, elapsedMs: 1, uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'd'.repeat(64),
    spoolId: 'spool-recovery',
  };
  return createTrustedContinuationInitialTurn(prepared, 'source-session');
}

beforeEach(() => {
  emits.length = 0;
  vi.mocked(loadSdk).mockReset();
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReturnValue(() => undefined);
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.updateCliSessionId).mockReset();
  vi.mocked(sessionRepo.setModel).mockClear();
  vi.mocked(sessionRepo.setThinking).mockClear();
  vi.mocked(sessionRepo.setAgentRuntimeProfile).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSession A1-HIGH-1 失败语义 — SDK 流终止前没 emit first session_id frame', () => {
  it('restores the persisted Agent and Plugin root for native Claude resume', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn((args: { options: Record<string, unknown> }) => {
        capturedOptions = args.options;
        return mockQuery;
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name, description, inputSchema, handler,
      })),
    } as never);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-agent-resume', agentId: 'claude-code', cwd: '/tmp/test', title: 'agent',
      source: 'sdk', lifecycle: 'dormant', activity: 'idle', startedAt: 1,
      lastEventAt: 2, endedAt: null, archivedAt: null, permissionMode: 'plan',
      cliSessionId: 'cli-agent-resume',
      agentProfileName: 'reviewer-claude',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer-claude',
    });
    mockQuery.pushFrame({
      type: 'system', subtype: 'init', session_id: 'cli-agent-resume',
      model: 'claude-sonnet-5',
    });

    const handle = await bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'continue',
      resume: 'app-agent-resume',
    });

    expect(handle.sessionId).toBe('app-agent-resume');
    expect(capturedOptions).toMatchObject({
      resume: 'cli-agent-resume',
      agent: 'reviewer-claude',
      plugins: [{ type: 'local', path: '/plugins/reviewer-claude' }],
    });
    expect(sessionRepo.setAgentRuntimeProfile).toHaveBeenCalledWith(
      'app-agent-resume',
      {
        agentProfileName: 'reviewer-claude',
        agentProfileSource: 'plugin',
        agentPluginDir: '/plugins/reviewer-claude',
      },
    );
    mockQuery.endStream();
  });

  it('emits the recovery correlation marker only when the first Claude turn is dequeued', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    let firstUserMessage: Promise<unknown> | undefined;
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
        firstUserMessage = args.prompt[Symbol.asyncIterator]().next();
        return mockQuery;
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name, description, inputSchema, handler,
      })),
    } as never);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-correlated', agentId: 'claude-code', cwd: '/tmp/test', title: 'recovery',
      source: 'sdk', lifecycle: 'dormant', activity: 'idle', startedAt: 1,
      lastEventAt: 2, endedAt: null, archivedAt: null, permissionMode: 'plan',
    });
    mockQuery.pushFrame({
      type: 'system', subtype: 'init', session_id: 'cli-correlated', model: 'claude-sonnet-5',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test', prompt: 'review', resume: 'app-correlated',
      skipFirstUserEmit: true,
      initialEnqueueOptions: {
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: 'correlation-1',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await createPromise;
    const first = await firstUserMessage as {
      value: { uuid?: string };
    };
    mockQuery.pushFrame({
      type: 'user',
      uuid: first.value.uuid,
      message: { role: 'user', content: 'review' },
    });
    mockQuery.endStream();

    await vi.waitFor(() => expect(emits).toContainEqual(expect.objectContaining({
      sessionId: 'app-correlated',
      kind: 'message',
      payload: expect.objectContaining({
        role: 'user', text: 'review', turnCorrelationId: 'correlation-1',
      }),
    })));
  });

  it('deduplicates a keyed first recovery turn after provider acceptance and finalize failure', async () => {
    const mockQuery = new MockSdkQuery();
    let firstUserMessage: Promise<unknown> | undefined;
    let throwSessionStart = true;
    const bridge = new ClaudeSdkBridge({
      createSessionHost: desktopClaudeSessionDefaultsHost,
      jsonlDiscoveryHost: desktopClaudeJsonlDiscoveryHost,
      recoveryFreshnessHost: desktopClaudeRecoveryFreshnessHost,
      restartSessionHost: desktopClaudeRestartSessionHost,
      sessionModelHost: desktopSessionModelControllerHost,
      usageSnapshotHost: createDesktopClaudeUsageSnapshotHost(sessionManager),
      permissionResponderHost: desktopClaudePermissionResponderHost,
      cwdTransitionHost: desktopClaudeCwdTransitionHost,
      messageControllerHost: desktopClaudeMessageControllerHost,
      sessionLifecycleHost: createDesktopClaudeSessionLifecycleHost(sessionManager),
      pendingOutgoingHost: desktopClaudePendingOutgoingHost,
      streamProcessorHost: createDesktopClaudeStreamProcessorHost(sessionManager),
      sessionFinalizeHost: createDesktopClaudeSessionFinalizeHost(sessionManager),
      canUseToolHost: desktopClaudeCanUseToolHost,
      createSessionSdkQueryHost: desktopClaudeCreateSessionSdkQueryHost,
      sessionManager,
      emit: (event) => {
        if (throwSessionStart && event.kind === 'session-start') {
          throwSessionStart = false;
          throw new Error('renderer projection failed');
        }
      },
    });
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
        firstUserMessage = args.prompt[Symbol.asyncIterator]().next();
        return mockQuery;
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name, description, inputSchema, handler,
      })),
    } as never);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-keyed', agentId: 'claude-code', cwd: '/tmp/test', title: 'recovery',
      source: 'sdk', lifecycle: 'dormant', activity: 'idle', startedAt: 1,
      lastEventAt: 2, endedAt: null, archivedAt: null, permissionMode: 'plan',
    });
    mockQuery.pushFrame({
      type: 'system', subtype: 'init', session_id: 'cli-keyed', model: 'claude-sonnet-5',
    });
    const enqueueOptions = { idempotencyKey: 'plan-late-decision:request-1' };

    const createPromise = bridge.createSession({
      cwd: '/tmp/test', prompt: 'approve plan', resume: 'app-keyed',
      skipFirstUserEmit: true, initialEnqueueOptions: enqueueOptions,
    });
    await expect(createPromise).rejects.toThrow('renderer projection failed');
    expect((await firstUserMessage as { value: { message: { content: string } } })
      .value.message.content).toBe('approve plan');

    const sessions = (bridge as unknown as {
      sessions: Map<string, {
        pendingUserMessages: unknown[];
        acceptedEnqueueFingerprints?: Map<string, string>;
      }>;
    }).sessions;
    expect(sessions.get('app-keyed')?.acceptedEnqueueFingerprints?.has(
      'plan-late-decision:request-1',
    )).toBe(true);
    await bridge.enqueueMessage('app-keyed', 'approve plan', [], enqueueOptions);
    expect(sessions.get('app-keyed')?.pendingUserMessages).toHaveLength(0);
    await expect(
      bridge.enqueueMessage('app-keyed', 'keep planning', [], enqueueOptions),
    ).rejects.toThrow('different payload');
    mockQuery.endStream();
  });

  it('trusted fresh-cli-reuse-app sends provider context, keeps app sid, and skips persisted re-emit', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    let firstUserMessage: Promise<unknown> | undefined;
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
        firstUserMessage = args.prompt[Symbol.asyncIterator]().next();
        return mockQuery;
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name, description, inputSchema, handler,
      })),
    } as never);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-recovery', agentId: 'claude-code', cwd: '/tmp/test', title: 'recovery',
      source: 'sdk', lifecycle: 'dormant', activity: 'idle', startedAt: 1,
      lastEventAt: 2, endedAt: null, archivedAt: null, permissionMode: 'plan',
      thinking: 'high',
    });
    mockQuery.pushFrame({
      type: 'system', subtype: 'init', session_id: 'fresh-cli-id', model: 'claude-sonnet-5',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      trustedContinuation: trustedRecoveryTurn(),
      resume: 'app-recovery',
      resumeMode: 'fresh-cli-reuse-app',
      permissionMode: 'plan',
    });
    await new Promise((resolve) => setImmediate(resolve));
    mockQuery.endStream();

    const handle = await createPromise;
    const first = await firstUserMessage as {
      value: { message: { content: string } };
    };
    expect(handle.sessionId).toBe('app-recovery');
    expect(first.value.message.content).toBe('FULL TRUSTED RECOVERY CONTEXT');
    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith(
      'app-recovery',
      'fresh-cli-id',
    );
    expect(
      emits.filter(
        (event) =>
          event.kind === 'message' &&
          (event.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(0);
  });

  it('rejects invalid fresh-reuse combinations and trusted native resume before SDK startup', async () => {
    const bridge = makeBridge();
    const turn = trustedRecoveryTurn();

    await expect(
      bridge.createSession({
        cwd: '/tmp/test', trustedContinuation: turn, resume: 'app', resumeMode: 'resume-cli',
      }),
    ).rejects.toThrow(/native Claude resume/);
    await expect(
      bridge.createSession({
        cwd: '/tmp/test', prompt: 'x', resumeMode: 'fresh-cli-reuse-app',
      }),
    ).rejects.toThrow(/requires an application session id/);
    await expect(
      bridge.createSession({
        cwd: '/tmp/test', prompt: 'x', resume: 'app', resumeMode: 'fresh-cli-reuse-app',
        resumeCliSid: 'cli',
      }),
    ).rejects.toThrow(/cannot include resumeCliSid/);
    expect(loadSdk).not.toHaveBeenCalled();
  });

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
    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'real-sid-123',
      model: 'claude-opus-4-8',
    });
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
    expect(sessionRepo.setModel).toHaveBeenCalledWith('real-sid-123', 'claude-opus-4-8');
  });

  it('finalizes canonical creation through the injected session host', async () => {
    const sessionFinalizeHost: ClaudeSessionFinalizeHost = {
      now: vi.fn(() => 7_000),
      updateCliSessionId: vi.fn(),
      setSandbox: vi.fn(),
      setRuntimeProvider: vi.fn(),
      setAgentRuntimeProfile: vi.fn(),
      setModel: vi.fn(),
      setThinking: vi.fn(),
      setExtraAllowWrite: vi.fn(),
      publishPersistedSession: vi.fn(),
      warn: vi.fn(),
    };
    const bridge = makeBridge({ sessionFinalizeHost });
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);
    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'finalize-host-sid',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'host-owned finalize',
      awaitCanonicalId: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    mockQuery.endStream();

    await expect(createPromise).resolves.toMatchObject({ sessionId: 'finalize-host-sid' });
    expect(sessionFinalizeHost.updateCliSessionId).toHaveBeenCalledWith(
      'finalize-host-sid',
      'finalize-host-sid',
    );
    expect(sessionFinalizeHost.setSandbox).toHaveBeenCalledWith('finalize-host-sid', 'off');
    expect(sessionFinalizeHost.publishPersistedSession).toHaveBeenCalledWith('finalize-host-sid');
    expect(emits).toContainEqual(expect.objectContaining({
      sessionId: 'finalize-host-sid',
      kind: 'session-start',
      ts: 7_000,
    }));
  });

  it('builds the SDK canUseTool callback with the injected host', async () => {
    const canUseToolHost: ClaudeCanUseToolHost = {
      createRequestId: vi.fn(() => 'injected-request-id'),
      now: vi.fn(() => 8_000),
      observeSandboxIntercept: vi.fn(),
    };
    const bridge = makeBridge({ canUseToolHost });
    const mockQuery = new MockSdkQuery();
    let capturedCanUseTool: CanUseTool | undefined;
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn((args: { options: { canUseTool?: CanUseTool } }) => {
        capturedCanUseTool = args.options.canUseTool;
        return mockQuery;
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      })),
    } as never);
    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'can-use-tool-host-sid',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'host-owned permission callback',
      awaitCanonicalId: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    mockQuery.endStream();
    await createPromise;

    const callbackContext = {} as Parameters<CanUseTool>[2];
    await expect(capturedCanUseTool?.(
      'SandboxNetworkAccess',
      { host: 'blocked.example' },
      callbackContext,
    )).resolves.toMatchObject({ behavior: 'deny', interrupt: false });
    expect(canUseToolHost.createRequestId).toHaveBeenCalledOnce();
    expect(canUseToolHost.observeSandboxIntercept).toHaveBeenCalledWith('blocked.example');

    const abortController = new AbortController();
    abortController.abort();
    await expect(capturedCanUseTool?.(
      'AskUserQuestion',
      { questions: [] },
      { toolUseID: 'tool-use-1', signal: abortController.signal } as Parameters<CanUseTool>[2],
    )).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(canUseToolHost.now).toHaveBeenCalledWith();
    expect(emits).toContainEqual(expect.objectContaining({
      sessionId: 'can-use-tool-host-sid',
      kind: 'waiting-for-user',
      ts: 8_000,
      payload: expect.objectContaining({ requestId: 'injected-request-id' }),
    }));
  });

  it('constructs the provider query through the injected aggregate host', async () => {
    const mockQuery = new MockSdkQuery();
    const buildQueryOptions = vi.fn(
      desktopClaudeCreateSessionSdkQueryHost.buildQueryOptions,
    );
    const createSessionSdkQueryHost: ClaudeCreateSessionSdkQueryHost = {
      ...desktopClaudeCreateSessionSdkQueryHost,
      loadSdk: vi.fn(async () => ({
        query: vi.fn(() => mockQuery) as never,
      })),
      runtimeOptions: vi.fn(() => ({
        executable: 'node' as const,
        env: { INJECTED_QUERY_HOST: '1' },
      })),
      prepareBrowserRuntime: vi.fn((_applicationSessionId, environment) => ({
        environment: { ...environment, PATH: '/private/browser-bin:/usr/bin' },
      })),
      resolveBinary: vi.fn(() => '/injected/claude'),
      buildSandboxOptions: vi.fn(() => ({})),
      prepareGatewaySandboxSettings: vi.fn(({ settingsPath, sandboxOpts }) => ({
        settingsPath,
        sandboxOpts,
        childEnv: {},
        settingsBackedSandbox: false,
        cleanup: undefined,
      })),
      buildMcpServers: vi.fn(async () => ({ agentDeckMcpServer: null })),
      buildQueryOptions,
      systemPromptAppend: vi.fn(() => 'INJECTED SYSTEM PROMPT'),
      plugins: vi.fn(() => []),
      runtimeMetadataHooks: vi.fn(() => ({})),
      cleanupGatewaySandboxSettings: vi.fn(),
      observeSandboxConfiguration: vi.fn(),
      warn: vi.fn(),
    };
    const bridge = makeBridge({ createSessionSdkQueryHost });
    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-query-host-sid',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'host-owned query',
      awaitCanonicalId: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    mockQuery.endStream();

    await expect(createPromise).resolves.toMatchObject({ sessionId: 'sdk-query-host-sid' });
    expect(createSessionSdkQueryHost.loadSdk).toHaveBeenCalledOnce();
    expect(createSessionSdkQueryHost.runtimeOptions).toHaveBeenCalledOnce();
    expect(createSessionSdkQueryHost.prepareBrowserRuntime).toHaveBeenCalledWith(
      expect.any(String),
      { INJECTED_QUERY_HOST: '1' },
    );
    expect(createSessionSdkQueryHost.resolveBinary).toHaveBeenCalledOnce();
    expect(createSessionSdkQueryHost.observeSandboxConfiguration).toHaveBeenCalledOnce();
    expect(buildQueryOptions).toHaveBeenCalledWith(expect.objectContaining({
      claudeBinary: '/injected/claude',
      systemPromptAppend: 'INJECTED SYSTEM PROMPT',
      runtime: {
        executable: 'node',
        env: {
          INJECTED_QUERY_HOST: '1',
          PATH: '/private/browser-bin:/usr/bin',
        },
      },
    }));
  });

  it('default new session fast-return：先返回 temp id，后台 first-id 后 rename 且不重复首条事件', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'real-fast-sid',
      model: 'claude-sonnet-5',
    });

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
    expect(sessionRepo.setModel).toHaveBeenCalledWith('real-fast-sid', 'claude-sonnet-5');
    expect(emits.filter((e) => e.kind === 'session-start')).toHaveLength(1);
    expect(
      emits.filter(
        (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(1);

    mockQuery.endStream();
  });

  it('injects read-only Stop hooks and finalizes an effort observed before the DB row exists', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    let hookResult: Promise<unknown> | undefined;
    const queryFactory = vi.fn((args: unknown) => {
      const options = (args as {
        options: {
          hooks: {
            Stop: Array<{
              hooks: Array<(
                input: unknown,
                toolUseId: undefined,
                options: { signal: AbortSignal },
              ) => Promise<unknown>>;
            }>;
            StopFailure: unknown[];
          };
        };
      }).options;
      expect(options.hooks.StopFailure).toHaveLength(1);
      hookResult = options.hooks.Stop[0].hooks[0](
        { hook_event_name: 'Stop', effort: { level: 'xhigh' } },
        undefined,
        { signal: new AbortController().signal },
      );
      return mockQuery;
    });
    vi.mocked(loadSdk).mockResolvedValue({
      query: queryFactory,
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      })),
    } as never);
    mockQuery.pushFrame({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-hook-early',
      model: 'claude-opus-4-8',
    });

    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
      awaitCanonicalId: true,
    });
    await new Promise((r) => setImmediate(r));
    mockQuery.endStream();

    const handle = await createPromise;
    await expect(hookResult).resolves.toEqual({});
    expect(handle.sessionId).toBe('sid-hook-early');
    expect(sessionRepo.setThinking).toHaveBeenCalledWith('sid-hook-early', 'xhigh');
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

  it('fast-return startup failures stay visible after failure cleanup marks expectedClose', async () => {
    const bridge = makeBridge();
    let visibleSessionId: string | undefined;
    vi.mocked(sessionRepo.get).mockImplementation((sessionId) =>
      sessionId === visibleSessionId
        ? ({
            id: sessionId,
            agentId: 'claude-code',
            cwd: '/tmp/test',
            title: 'startup failure',
            source: 'sdk',
            lifecycle: 'active',
            activity: 'working',
            startedAt: 1,
            lastEventAt: 1,
            endedAt: null,
            archivedAt: null,
          } as never)
        : null,
    );
    vi.mocked(loadSdk).mockResolvedValue({
      query: vi.fn(() => {
        throw new Error(
          'Cannot use both a settings file path and the sandbox option.',
        );
      }),
      tool: vi.fn((name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      })),
    } as never);

    const handle = await bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
    });
    visibleSessionId = handle.sessionId;

    await vi.waitFor(() => {
      expect(
        emits.find(
          (event) =>
            event.sessionId === handle.sessionId &&
            event.kind === 'message' &&
            (event.payload as { error?: boolean }).error === true,
        ),
      ).toBeDefined();
    });

    const failure = emits.find(
      (event) =>
        event.sessionId === handle.sessionId &&
        event.kind === 'message' &&
        (event.payload as { error?: boolean }).error === true,
    );
    expect((failure?.payload as { text: string }).text).toContain(
      'Cannot use both a settings file path and the sandbox option.',
    );
    expect(
      emits.some(
        (event) =>
          event.sessionId === handle.sessionId &&
          event.kind === 'finished' &&
          (event.payload as { ok?: boolean }).ok === false,
      ),
    ).toBe(true);
  });
});
