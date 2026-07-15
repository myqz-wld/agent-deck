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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

const appServerClientMock = vi.hoisted(() => {
  const state = {
    nextThread: null as unknown,
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
        startThread: vi.fn((_opts: unknown) => {
          if (!state.nextThread) throw new Error('test setup forgot nextThread');
          return state.nextThread;
        }),
        dispose: vi.fn(),
      };
    }),
  };
  return state;
});

// 与 early-err-cleanup test 同款入口模块 stub
vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
  resolveCodexBinary: () => null,
  prependBundledCodexPathDirs: vi.fn(),
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

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import { THREAD_STARTED_FALLBACK_MS } from '@main/adapters/codex-cli/sdk-bridge/constants';
import type { AgentEvent } from '@shared/types';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';

const emits: AgentEvent[] = [];

function trustedRecoveryTurn() {
  const prepared: PreparedContinuationContext = {
    version: 1,
    providerPrompt: 'FULL TRUSTED RECOVERY PROVIDER CONTEXT',
    persistedUserText: 'Continue from here.',
    source: { eventRevision: 9, rebuildAfterRevision: 0, maxEventId: 9 },
    checkpoint: { id: 2, throughRevision: 9, formatVersion: 1, refreshed: false },
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

  runStreamed = vi.fn((_input: unknown, _opts: unknown) => {
    const startedThreadId = this.startedThreadId;
    return new Promise<{ events: AsyncIterable<unknown> }>((resolve, reject) => {
      this.rejectStreamed = reject;
      // 立即返回一个 events async-iterable，若 startedThreadId 非空则先 yield 一条 thread.started
      const events = (async function* () {
        if (startedThreadId !== null) {
          yield { type: 'thread.started', thread_id: startedThreadId } as unknown;
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

let nextThread: ControlledThread | null = null;

beforeEach(() => {
  emits.length = 0;
  nextThread = null;
  appServerClientMock.nextThread = null;
  appServerClientMock.resumeThreadSyncThrow = null;
  appServerClientMock.constructorThrow = null;
  appServerClientMock.CodexAppServerClient.mockClear();
  mcpSessionTokenMap.clearAll();
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.setCodexSandbox).mockReset();
  vi.mocked(sessionRepo.setModel).mockReset();
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

describe('codex createSession internal.threadId init (REVIEW_79 MED-1)', () => {
  // ── MED-1: 反向 rename 后 normal resume → case 2 不误触 fork ───────────────────
  it('reverse-rename 后 normal resume：internal.threadId 初值 = cli-sid(resumeCliSid)，SDK 返同 cli-sid → case 2 不调 updateCliSessionId / 不打 fork warn', async () => {
    // 反向 rename 场景：applicationSid=A, cli_session_id=C (C≠A)
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-A',
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      cliSessionId: 'cli-C',
    } as unknown as ReturnType<typeof sessionRepo.get>);

    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    nextThread.startedThreadId = 'cli-C'; // SDK resumeThread(cli-C) 正常返同 id

    const bridge = makeBridge();
    // caller 显式传 resumeCliSid（recover-and-send-impl.ts:297 / restart-controller.ts:140 行为）
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      resume: 'app-A',
      resumeCliSid: 'cli-C',
    });

    expect(handle.sessionId).toBe('app-A'); // facade 返 applicationSid

    // 关键断言:internal.threadId 初值是 cli-C 而非 app-A
    // (sessions Map key = applicationSid = app-A;反向 rename 后 sessions.id 不变)
    expect(getInternalThreadId(bridge, 'app-A')).toBe('cli-C');

    // case 2 命中 → 不调 updateCliSessionId(case 3 才调)
    expect(sessionManager.updateCliSessionId).not.toHaveBeenCalled();

    // 不打误导性 fork warn(case 3 特征)
    const forkWarns = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('SDK returned thread_id'),
    );
    expect(forkWarns).toHaveLength(0);
  });

  it('binds recovery correlation and idempotency to the first dequeued Codex turn', async () => {
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-correlated', agentId: 'codex-cli', cwd: '/repo', title: 't', source: 'sdk',
      lifecycle: 'dormant', activity: 'idle', startedAt: 1, lastEventAt: 2,
      endedAt: null, archivedAt: null, codexSandbox: 'workspace-write',
      cliSessionId: 'cli-correlated',
    } as unknown as ReturnType<typeof sessionRepo.get>);
    const thread = new ControlledThread();
    thread.startedThreadId = 'cli-correlated';
    appServerClientMock.nextThread = thread;
    const bridge = makeBridge();
    const enqueueOptions = {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'correlation-1',
      idempotencyKey: 'initial-key',
    };

    await bridge.createSession({
      cwd: '/repo', prompt: 'review', resume: 'app-correlated',
      resumeCliSid: 'cli-correlated', skipFirstUserEmit: true,
      initialEnqueueOptions: enqueueOptions,
    });

    expect(emits).toContainEqual(expect.objectContaining({
      sessionId: 'app-correlated',
      kind: 'message',
      payload: expect.objectContaining({
        role: 'user', text: 'review', turnCorrelationId: 'correlation-1',
      }),
    }));
    const sessions = (bridge as unknown as {
      sessions: Map<string, { pendingMessages: unknown[]; acceptedEnqueueFingerprints?: Map<string, string> }>;
    }).sessions;
    expect(sessions.get('app-correlated')?.acceptedEnqueueFingerprints?.has('initial-key'))
      .toBe(true);
    await bridge.enqueueMessage('app-correlated', 'review', [], enqueueOptions);
    expect(sessions.get('app-correlated')?.pendingMessages).toHaveLength(0);
    await expect(
      bridge.enqueueMessage('app-correlated', 'different', [], enqueueOptions),
    ).rejects.toThrow('different payload');
  });

  // ── fresh-cli-reuse-app 保留 case 3（修法不破坏 intended fork 路径）─────────────
  it('fresh-cli-reuse-app：effectiveResumeThreadId=null → internal.threadId=opts.resume(applicationSid) → SDK startThread 返新 id → case 3 调 updateCliSessionId(intended)', async () => {
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-A',
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      cliSessionId: 'cli-OLD',
    } as unknown as ReturnType<typeof sessionRepo.get>);

    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    nextThread.startedThreadId = 'cli-NEW'; // startThread 返新 fresh thread id

    const bridge = makeBridge();
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      resume: 'app-A',
      resumeMode: 'fresh-cli-reuse-app',
    });

    expect(handle.sessionId).toBe('app-A');
    // fresh-cli-reuse-app: effectiveResumeThreadId=null → threadId 初值 = opts.resume = app-A
    // case 3 后 thread-loop 把 internal.threadId 修正成 cli-NEW
    expect(getInternalThreadId(bridge, 'app-A')).toBe('cli-NEW');
    // case 3 命中 → 调 updateCliSessionId(applicationSid, newId)（intended 反向 rename）
    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith('app-A', 'cli-NEW');
  });

  it('trusted recovery 可窄化进入 fresh-cli-reuse-app：provider 收 full context、app sid 稳定且不重复 emit user', async () => {
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'app-A',
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      cliSessionId: 'cli-OLD',
    } as unknown as ReturnType<typeof sessionRepo.get>);
    nextThread = new ControlledThread();
    appServerClientMock.nextThread = nextThread;
    nextThread.startedThreadId = 'cli-RECOVERED';
    const turn = trustedRecoveryTurn();

    const handle = await makeBridge().createSession({
      cwd: '/repo',
      trustedContinuation: turn,
      resume: 'app-A',
      resumeMode: 'fresh-cli-reuse-app',
      skipFirstUserEmit: true,
    });

    expect(handle.sessionId).toBe('app-A');
    expect(nextThread.runStreamed).toHaveBeenCalledWith(
      [{ type: 'text', text: turn.providerPrompt, text_elements: [] }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith('app-A', 'cli-RECOVERED');
    expect(
      emits.filter(
        (event) => event.kind === 'message' && (event.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(0);
  });

  it('trusted recovery 拒绝 native resume 与 resumeOnly，且 fresh reuse option 组合 fail closed', async () => {
    const bridge = makeBridge();
    const turn = trustedRecoveryTurn();

    await expect(
      bridge.createSession({ cwd: '/repo', trustedContinuation: turn, resume: 'app-A' }),
    ).rejects.toThrow(/new Codex provider thread/);
    await expect(
      bridge.createSession({
        cwd: '/repo',
        trustedContinuation: turn,
        resume: 'app-A',
        resumeMode: 'fresh-cli-reuse-app',
        resumeOnly: true,
      }),
    ).rejects.toThrow(/resumeOnly/);
    await expect(
      bridge.createSession({
        cwd: '/repo',
        prompt: 'invalid',
        resumeMode: 'fresh-cli-reuse-app',
      }),
    ).rejects.toThrow(/application session id/);
    await expect(
      bridge.createSession({
        cwd: '/repo',
        prompt: 'invalid',
        resumeCliSid: 'cli-without-app',
      }),
    ).rejects.toThrow(/resumeCliSid/);
    await expect(
      bridge.createSession({
        cwd: '/repo',
        trustedContinuation: turn,
        resume: 'app-A',
        resumeMode: 'fresh-cli-reuse-app',
        resumeCliSid: 'cli-OLD',
      }),
    ).rejects.toThrow(/cannot resume a native/);
  });
});

describe('codex createSession new path latency', () => {
  it('awaitCanonicalId waits for thread.started and returns the post-rename real id', async () => {
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;
    const onRegistered = vi.fn();

    const bridge = makeBridge();
    const createPromise = bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      codexSandbox: 'workspace-write',
      awaitCanonicalId: true,
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'lead-session', depth: 1 },
        onRegistered,
      },
    });

    await flushAsyncWork();
    expect(pushThread.runStreamed).toHaveBeenCalledTimes(1);
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
    const provisionalStart = emits.find((event) => event.kind === 'session-start');
    expect(provisionalStart?.payload).toMatchObject({
      initialSpawnLink: { parentSessionId: 'lead-session', depth: 1 },
    });
    expect(onRegistered).toHaveBeenCalledWith(provisionalStart?.sessionId);

    pushThread.push({ type: 'thread.started', thread_id: 'real-thread-1' });
    await flushAsyncWork();
    const handle = await createPromise;

    expect(handle.sessionId).toBe('real-thread-1');
    expect(sessionManager.renameSdkSession).toHaveBeenCalledWith(
      expect.any(String),
      'real-thread-1',
    );

    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(handle.sessionId)).toBe(true);
  });

  it('新建会话立即返回 temp session，thread.started 后后台 rename，不重复 emit start/user', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;

    const bridge = makeBridge();
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      codexSandbox: 'workspace-write',
    });
    const tempSid = handle.sessionId;

    expect(tempSid).not.toBe('real-thread-1');
    expect(pushThread.runStreamed).not.toHaveBeenCalled();
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
    expect(sessionManager.claimAsSdk).toHaveBeenCalledWith(tempSid);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith(tempSid, 'workspace-write');

    const startsBeforeRename = emits.filter((e) => e.kind === 'session-start');
    const userMessagesBeforeRename = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(startsBeforeRename).toHaveLength(1);
    expect(startsBeforeRename[0]?.sessionId).toBe(tempSid);
    expect(userMessagesBeforeRename).toHaveLength(1);
    expect(userMessagesBeforeRename[0]?.sessionId).toBe(tempSid);

    const sessionsBeforeStart = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessionsBeforeStart.has(tempSid)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(pushThread.runStreamed).toHaveBeenCalledTimes(1);

    pushThread.push({ type: 'thread.started', thread_id: 'real-thread-1' });
    await flushAsyncWork();

    expect(sessionManager.renameSdkSession).toHaveBeenCalledWith(tempSid, 'real-thread-1');

    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(tempSid)).toBe(false);
    expect(sessions.has('real-thread-1')).toBe(true);

    expect(emits.filter((e) => e.kind === 'session-start')).toHaveLength(1);
    expect(
      emits.filter(
        (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(1);
  });

  it('新建会话后台 early error 只补 error/finished，不重复 emit start/user', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    pushThread.rejectOnRun = new Error('spawn boom');
    appServerClientMock.nextThread = pushThread;

    const bridge = makeBridge();
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      codexSandbox: 'workspace-write',
    });
    const tempSid = handle.sessionId;

    expect(pushThread.runStreamed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();

    expect(
      emits.some(
        (e) =>
          e.kind === 'message' &&
          (e.payload as { error?: boolean; text?: string }).error === true &&
          ((e.payload as { text?: string }).text ?? '').includes('spawn boom'),
      ),
    ).toBe(true);

    expect(emits.filter((e) => e.kind === 'session-start')).toHaveLength(1);
    expect(
      emits.filter(
        (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(1);
    expect(
      emits.filter(
        (e) =>
          e.kind === 'finished' &&
          (e.payload as { ok?: boolean; subtype?: string }).ok === false &&
          (e.payload as { subtype?: string }).subtype === 'error',
      ),
    ).toHaveLength(1);
    expect(emits.every((e) => e.sessionId === tempSid)).toBe(true);
    expect(sessionManager.delete).not.toHaveBeenCalled();
  });

  it('temp 会话在 thread.started 前关闭后，迟到 real id 不 rename / 不复活 session', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;

    const bridge = makeBridge();
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      codexSandbox: 'workspace-write',
    });
    const tempSid = handle.sessionId;

    await bridge.closeSession(tempSid);
    await vi.advanceTimersByTimeAsync(0);
    pushThread.push({ type: 'thread.started', thread_id: 'real-after-close' });
    await flushAsyncWork();

    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(pushThread.runStreamed).not.toHaveBeenCalled();
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
    expect(sessions.has(tempSid)).toBe(false);
    expect(sessions.has('real-after-close')).toBe(false);
    expect(
      emits.some(
        (e) =>
          e.kind === 'message' &&
          (e.payload as { error?: boolean; text?: string }).error === true &&
          ((e.payload as { text?: string }).text ?? '').includes('real-after-close'),
      ),
    ).toBe(false);
  });

  it('新建会话 thread.started 超时后仍补 error/finished 并清理 temp token', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;

    const bridge = makeBridge();
    await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      codexSandbox: 'workspace-write',
    });
    const token = getInjectedMcpToken();

    await vi.advanceTimersByTimeAsync(0);
    expect(pushThread.runStreamed).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(THREAD_STARTED_FALLBACK_MS);
    await flushAsyncWork();

    expect(
      emits.some(
        (e) =>
          e.kind === 'message' &&
          (e.payload as { error?: boolean; text?: string }).error === true &&
          ((e.payload as { text?: string }).text ?? '').includes('30 秒内未发出 thread_id'),
      ),
    ).toBe(true);
    expect(
      emits.filter(
        (e) =>
          e.kind === 'finished' &&
          (e.payload as { ok?: boolean; subtype?: string }).ok === false &&
          (e.payload as { subtype?: string }).subtype === 'error',
      ),
    ).toHaveLength(1);
    expect(emits.filter((e) => e.kind === 'session-start')).toHaveLength(1);
    expect(
      emits.filter(
        (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
      ),
    ).toHaveLength(1);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(sessionManager.delete).not.toHaveBeenCalled();
  });
});

describe('codex createSession early-failure rollback (REVIEW_79 test gap)', () => {
  // ── rollback 路径 1: ensureCodex throw（app-server client constructor throw）──────────────────
  it('ensureCodex throw（app-server client 构造失败）→ catch → token released + sessions Map 不残留 + throw 透传', async () => {
    appServerClientMock.constructorThrow = new Error('app-server client boom');

    const bridge = makeBridge();
    const err = await bridge
      .createSession({ cwd: '/repo', prompt: 'hi', resume: 'sess-e1' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/app-server client boom/);
    const token = getInjectedMcpToken();

    // token allocate 发生在 validate phase（throw 前），rollback 必须 release
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    // sessions Map 不残留（resume 路径 sessions.set 在 ensureCodex 之后，此处尚未 set，
    // rollback delete 仍 idempotent no-op 安全）
    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has('sess-e1')).toBe(false);
  });

  // ── rollback 路径 2: resumeThread sync throw ───────────────────────────────────
  it('resumeThread sync throw（SDK 参数校验失败）→ catch → token released + releaseSdkClaim + throw 透传', async () => {
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-e2',
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      cliSessionId: 'sess-e2',
    } as unknown as ReturnType<typeof sessionRepo.get>);
    appServerClientMock.resumeThreadSyncThrow = new Error('resumeThread param invalid');

    const bridge = makeBridge();
    const err = await bridge
      .createSession({ cwd: '/repo', prompt: 'hi', resume: 'sess-e2' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/resumeThread param invalid/);
    const token = getInjectedMcpToken();

    // rollback: token released + (resume 路径) releaseSdkClaim(opts.resume)
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-e2');
  });
});
