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
  },
}));

// per-session token map 是真 module（in-memory Map）— rollback 断言 token 被 release。
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { CodexSdkBridge } from '@main/adapters/codex-cli/sdk-bridge';
import type { AgentEvent } from '@shared/types';

const emits: AgentEvent[] = [];

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

function getInternalThreadId(bridge: CodexSdkBridge, sid: string): string | null | undefined {
  const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string | null }> })
    .sessions;
  return sessions.get(sid)?.threadId;
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

    // token allocate 发生在 validate phase（throw 前），rollback 必须 release
    expect(mcpSessionTokenMap.get('sess-e1')).toBeNull();
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

    // rollback: token released + (resume 路径) releaseSdkClaim(opts.resume)
    expect(mcpSessionTokenMap.get('sess-e2')).toBeNull();
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-e2');
  });
});
