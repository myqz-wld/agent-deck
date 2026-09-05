import { CodexPendingTurnQueue } from '@main/adapters/codex-cli/sdk-bridge/pending-turn-queue';
/**
 * codex sdk-bridge.consume-fork（thread-loop case 3 rename + restart-controller）单测
 * （codex-tests-plan P2 Step 2.1）。
 *
 * 镜像 claude `__tests__/sdk-bridge.consume-fork.test.ts` 但 codex 端架构差异显著：
 * - claude 一切走 `consume` private method（同 1 个流式 SDK query 处理）
 * - codex 拆 `ThreadLoop.runTurnLoop`（持 thread.started case 1/2/3 三态）+
 *   `RestartController.setCodexSandbox`（next-turn sandbox apply 控制器）
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
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { afterEach, beforeEach, vi } from 'vitest';

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

import type { CodexAppServerStreamEvent } from '@main/adapters/codex-cli/app-server/client';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { emits } from './sdk-bridge/_setup';

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
    runtimeIdentity: null,
    pendingTurns: new CodexPendingTurnQueue([{ input: 'hi' }]),
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
    pendingPermissions: new Map(),
  };
}


export { eventBus } from '@main/event-bus';
export { sessionManager } from '@main/session/manager';
export { sessionRepo } from '@main/store/session-repo';
export { emits, makeBridge } from './sdk-bridge/_setup';
export { makeFakeThread, makeInternalSession };
