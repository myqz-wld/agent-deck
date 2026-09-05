import { describe, expect, it, vi } from 'vitest';
import type { CodexPendingTurnQueue } from '../pending-turn-queue';
import {
  appServerClientMock,
  ControlledThread,
  emits,
  getInternalThreadId,
  makeBridge,
  sessionManager,
  sessionRepo,
  trustedRecoveryTurn,
} from './create-session-fixture';
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

    const nextThread = new ControlledThread();
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
      sessions: Map<string, { pendingTurns: CodexPendingTurnQueue; acceptedEnqueueFingerprints?: Map<string, string> }>;
    }).sessions;
    expect(sessions.get('app-correlated')?.acceptedEnqueueFingerprints?.has('initial-key'))
      .toBe(true);
    await bridge.enqueueMessage('app-correlated', 'review', [], enqueueOptions);
    expect(sessions.get('app-correlated')?.pendingTurns).toHaveLength(0);
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

    const nextThread = new ControlledThread();
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
    const nextThread = new ControlledThread();
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
