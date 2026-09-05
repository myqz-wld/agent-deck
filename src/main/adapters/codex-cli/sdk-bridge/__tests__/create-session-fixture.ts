/**
 * codex createSession — internal.threadId 初值 + 早期失败 rollback 回归单测
 * （REVIEW_79 Batch D1）。
 *
 * 必须真跑 createSessionImpl（不能用 _setup.ts TestCodexBridge override createSession 捷径），
 * 所以本文件直接 `new CodexSdkBridge({emit})` + mock CodexAppServerClient 注入 fake thread，
 * 与 sdk-bridge.early-err-cleanup.test.ts 同款 infra。
 *
 * 覆盖两组修复点：
 *
 * 1. **MED-1（reviewer-claude 单方 + lead 现场验证 / claude parity 偏差）**：
 *    internal.threadId 初值改用 effectiveResumeThreadId（cli-sid 维度）而非 opts.resume
 *    （applicationSid 维度）。反向 rename 后（appSid=A,cli=C,C≠A）normal resume 走
 *    resumeThread(C) → SDK 返 thread.started{thread_id:C} → thread-loop case 2 正常分支
 *    （internal.threadId===C===ev.thread_id），**不**误触 case 3 fork-detect（不调
 *    updateCliSessionId / 不打误导性 fork warn）。修前 internal.threadId=A → A!==C → case 3。
 *
 * 2. **rollback 枚举路径（reviewer-claude + reviewer-codex 双方独立 MED/INFO 测试缺口）**：
 *    REVIEW_60 MED-codex-2 顶层 try/catch + runCreateSessionRollback 的两条 throw 路径：
 *    - ensureCodex throw（app-server client 构造失败）→ catch → rollback 清 token + Map + throw 透传
 *    - resumeThread sync throw（app-server 参数校验失败）→ 同上
 */
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { afterEach, beforeEach, vi } from 'vitest';
import { codexBridgeTestRuntimeHost } from './runtime-host-fixture';

const appServerClientMock = vi.hoisted(() => {
  const state = {
    nextThread: null as unknown,
    startThreadOptions: [] as unknown[],
    resumeThreadSyncThrow: null as Error | null,
    constructorThrow: null as Error | null,
    CodexAppServerClient: vi.fn(() => {
      if (state.constructorThrow) throw state.constructorThrow;
      return {
        resumeThread: vi.fn((_id: string, _opts: unknown) => {
          if (state.resumeThreadSyncThrow) throw state.resumeThreadSyncThrow;
          if (!state.nextThread) throw new Error('test setup forgot nextThread');
          return state.nextThread;
        }),
        startThread: vi.fn((opts: unknown) => {
          state.startThreadOptions.push(opts);
          if (!state.nextThread) throw new Error('test setup forgot nextThread');
          return state.nextThread;
        }),
        dispose: vi.fn(),
      };
    }),
  };
  return state;
});

const reasoningConfigMock = vi.hoisted(() => ({
  readTopLevel: vi.fn(() => 'xhigh' as const),
}));
const gatewayProfileMock = vi.hoisted(() => ({
  resolve: vi.fn((provider: string | null | undefined) =>
    provider?.trim()
      ? {
          id: provider.trim(),
          profilePath: `/codex/gateways/${provider.trim()}.toml`,
          modelProvider: `native-${provider.trim()}`,
          configOverrides: {},
        }
      : null),
}));

// 与 early-err-cleanup test 同款入口模块 stub
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
vi.mock('@main/codex-config/toml-writer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/codex-config/toml-writer')>()),
  readTopLevelModelReasoningEffortFromCodexConfig: reasoningConfigMock.readTopLevel,
}));
vi.mock('@main/codex-config/gateway-profiles', () => ({
  resolveCodexGatewayProfile: gatewayProfileMock.resolve,
}));
vi.mock('@main/codex-config/agent-deck-mcp-injector', () => ({
  buildAgentDeckMcpConfigForCodex: () => null,
  mergeCodexConfig: (a: unknown) => a,
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
    overrides: {
      get: vi.fn(),
      setCodexSandbox: vi.fn(),
      setRuntimeProvider: vi.fn(),
      setModel: vi.fn(),
      setThinking: vi.fn(),
      setExtraAllowWrite: vi.fn(),
    },
  }),
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(async () => undefined),
  },
}));

// per-session token map 是真 module（in-memory Map）— rollback 断言 token 被 release。
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';

import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import type { AgentEvent } from '@shared/types';

const emits: AgentEvent[] = [];

function trustedRecoveryTurn() {
  const prepared: PreparedContinuationContext = {
    version: 2,
    providerPrompt: 'FULL TRUSTED RECOVERY PROVIDER CONTEXT',
    persistedUserText: 'Continue from here.',
    source: { eventRevision: 9, rebuildAfterRevision: 0, maxEventId: 9 },
    checkpoint: { id: 2, throughRevision: 9, formatVersion: 2, refreshed: false },
    projection: { canonicalHash: 'd'.repeat(64), omittedFacts: 0 },
    quality: 'full',
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 100_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100,
      checkpointTokens: 20,
      rawTailTokens: 20,
      includedUserMessages: 1,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'e'.repeat(64),
    spoolId: 'recovery-spool',
  };
  return createTrustedContinuationInitialTurn(prepared, 'app-A');
}

/** runStreamed 受控：test 决定何时 emit thread.started / reject。 */
class ControlledThread {
  startedThreadId: string | null = null;
  rejectStreamed: ((err: Error) => void) | null = null;
  stageGatewayOptions = vi.fn();

  runStreamed = vi.fn((_input: unknown, _opts: unknown) => {
    const startedThreadId = this.startedThreadId;
    return new Promise<{ events: AsyncIterable<unknown> }>((resolve, reject) => {
      this.rejectStreamed = reject;
      // 立即返回一个 events async-iterable，若 startedThreadId 非空则先 yield 一条 thread.started
      const events = (async function* () {
        if (startedThreadId !== null) {
          yield {
            type: 'thread.started',
            thread_id: startedThreadId,
            runtimeIdentity: null,
          } as unknown;
          yield { type: 'turn.accepted', turn_id: 'turn-correlated' } as unknown;
        }
        // 之后挂起（不结束 stream，模拟 turn 还在跑）
        await new Promise<void>(() => {});
      })();
      resolve({ events });
    });
  });
}

class PushThread {
  private queue: unknown[] = [];
  private waiters: Array<(value: unknown) => void> = [];
  rejectOnRun: Error | null = null;
  stageGatewayOptions = vi.fn();

  runStreamed = vi.fn(async (_input: unknown, _opts: unknown) => {
    if (this.rejectOnRun) throw this.rejectOnRun;
    return {
      events: this.iterEvents(),
    };
  });

  push(event: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  private async *iterEvents(): AsyncIterable<unknown> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      yield await new Promise<unknown>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}


beforeEach(() => {
  emits.length = 0;
  appServerClientMock.nextThread = null;
  appServerClientMock.startThreadOptions.length = 0;
  appServerClientMock.resumeThreadSyncThrow = null;
  appServerClientMock.constructorThrow = null;
  appServerClientMock.CodexAppServerClient.mockClear();
  mcpSessionTokenMap.clearAll();
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setCodexSandbox).mockReset();
  vi.mocked(sessionRepo.setRuntimeProvider).mockReset();
  vi.mocked(sessionRepo.setModel).mockReset();
  vi.mocked(sessionRepo.setThinking).mockReset();
  reasoningConfigMock.readTopLevel.mockReset();
  reasoningConfigMock.readTopLevel.mockReturnValue('xhigh');
  gatewayProfileMock.resolve.mockClear();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.updateCliSessionId).mockReset();
  vi.mocked(sessionManager.delete).mockReset();
  vi.mocked(sessionManager.delete).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeBridge(): CodexSdkBridge {
  return new CodexSdkBridge({
    recoveryContinuationHost: {} as never,
    runtimeHost: codexBridgeTestRuntimeHost,
    emit: (e) => {
      emits.push(e);
    },
  });
}

function getInjectedMcpToken(): string {
  const calls = appServerClientMock.CodexAppServerClient.mock.calls as unknown as Array<
    [{ env?: Record<string, string> }]
  >;
  const token = calls.at(-1)?.[0].env?.AGENT_DECK_MCP_TOKEN;
  if (!token) throw new Error('missing test MCP token');
  return token;
}

function getInternalThreadId(bridge: CodexSdkBridge, sid: string): string | null | undefined {
  const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string | null }> })
    .sessions;
  return sessions.get(sid)?.threadId;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}


export { sessionManager } from '@main/session/manager';
export { sessionRepo } from '@main/store/session-repo';
export { THREAD_STARTED_FALLBACK_MS } from '../constants';
export {
  appServerClientMock,
  ControlledThread,
  emits,
  flushAsyncWork,
  gatewayProfileMock,
  getInjectedMcpToken,
  getInternalThreadId,
  makeBridge,
  PushThread,
  reasoningConfigMock,
  trustedRecoveryTurn,
};
