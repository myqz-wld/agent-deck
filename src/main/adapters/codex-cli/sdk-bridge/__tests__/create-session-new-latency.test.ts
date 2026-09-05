import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { describe, expect, it, vi } from 'vitest';
import {
  appServerClientMock,
  emits,
  flushAsyncWork,
  gatewayProfileMock,
  getInjectedMcpToken,
  makeBridge,
  PushThread,
  reasoningConfigMock,
  sessionManager,
  sessionRepo,
  THREAD_STARTED_FALLBACK_MS,
} from './create-session-fixture';
describe('codex createSession new path latency', () => {
  it('an explicit Gateway uses its native provider without inheriting config.toml reasoning', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;

    await makeBridge().createSession({
      cwd: '/repo',
      prompt: 'hi',
      provider: 'openrouter',
      codexSandbox: 'workspace-write',
    });

    expect(reasoningConfigMock.readTopLevel).not.toHaveBeenCalled();
    expect(appServerClientMock.startThreadOptions).toHaveLength(1);
    expect(appServerClientMock.startThreadOptions[0]).toMatchObject({
      modelProvider: 'native-openrouter',
    });
    expect(appServerClientMock.startThreadOptions[0]).not.toHaveProperty(
      'modelReasoningEffort',
    );
    expect(sessionRepo.setThinking).not.toHaveBeenCalled();
  });

  it('stages a loaded-thread Gateway switch for the next turn', async () => {
    vi.useFakeTimers();
    const pushThread = new PushThread();
    appServerClientMock.nextThread = pushThread;
    const bridge = makeBridge();
    const handle = await bridge.createSession({
      cwd: '/repo',
      prompt: 'hi',
      provider: 'working-provider',
      model: 'gpt-old',
      modelReasoningEffort: 'low',
      codexSandbox: 'workspace-write',
    });
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: handle.sessionId,
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'working',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      runtimeProvider: 'working-provider',
      model: 'gpt-old',
      thinking: 'low',
    } as unknown as ReturnType<typeof sessionRepo.get>);
    vi.mocked(sessionRepo.setRuntimeProvider).mockClear();
    vi.mocked(sessionRepo.setModel).mockClear();
    vi.mocked(sessionRepo.setThinking).mockClear();

    await bridge.setSessionModelOptions(handle.sessionId, {
      provider: 'new-provider',
      model: 'gpt-new',
      thinking: 'high',
    });

    expect(gatewayProfileMock.resolve).toHaveBeenCalledWith('new-provider');
    expect(sessionRepo.setRuntimeProvider).toHaveBeenCalledWith(
      handle.sessionId,
      'new-provider',
    );
    expect(sessionRepo.setModel).toHaveBeenCalledWith(handle.sessionId, 'gpt-new');
    expect(sessionRepo.setThinking).toHaveBeenCalledWith(handle.sessionId, 'high');
    expect(pushThread.stageGatewayOptions).toHaveBeenCalledWith({
      gatewayConfigOverrides: {},
      modelProvider: 'native-new-provider',
      model: 'gpt-new',
      effort: 'high',
    });
    expect(appServerClientMock.startThreadOptions[0]).toMatchObject({
      modelProvider: 'native-working-provider',
      model: 'gpt-old',
      modelReasoningEffort: 'low',
    });
  });

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
        hiddenFromHistory: true,
        onRegistered,
      },
    });

    await flushAsyncWork();
    expect(pushThread.runStreamed).toHaveBeenCalledTimes(1);
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalled();
    const provisionalStart = emits.find((event) => event.kind === 'session-start');
    expect(provisionalStart?.payload).toMatchObject({
      initialSpawnLink: { parentSessionId: 'lead-session', depth: 1 },
      initialHiddenFromHistory: true,
    });
    expect(onRegistered).toHaveBeenCalledWith(provisionalStart?.sessionId);

    pushThread.push({
      type: 'thread.started',
      thread_id: 'real-thread-1',
      runtimeIdentity: null,
    });
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

    pushThread.push({
      type: 'thread.started',
      thread_id: 'real-thread-1',
      runtimeIdentity: null,
    });
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
    pushThread.push({
      type: 'thread.started',
      thread_id: 'real-after-close',
      runtimeIdentity: null,
    });
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
