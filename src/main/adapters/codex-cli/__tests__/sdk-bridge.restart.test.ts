import { describe, expect, it, vi } from 'vitest';
import { CodexPendingTurnQueue } from '../sdk-bridge/pending-turn-queue';
import type { InternalSession } from '../sdk-bridge/types';
import {
  emits,
  eventBus,
  makeBridge,
  makeInternalSession,
  sessionManager,
  sessionRepo,
} from './consume-fork-fixture';
describe('codex RestartController.setCodexSandbox（next-turn apply）', () => {
  it('live session: persists + emits upsert + patches thread options without abort/create/queue loss', async () => {
    const bridge = makeBridge();
    const updateSandboxMode = vi.fn();
    const thread = {
      runStreamed: vi.fn(),
      updateSandboxMode,
    } as unknown as InternalSession['thread'];
    const internal = makeInternalSession(thread, 'sess-live');
    const currentTurn = new AbortController();
    internal.currentTurn = currentTurn;
    internal.currentTurnId = 'turn-active';
    internal.pendingTurns = new CodexPendingTurnQueue([{ input: 'queued-next-turn' }]);
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set('sess-live', internal);

    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-live',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'working',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp/ref'],
      })
      .mockReturnValue({
        id: 'sess-live',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'working',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write',
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp/ref'],
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    await bridge.setCodexSandbox('sess-live', 'workspace-write');

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(1);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-live', 'workspace-write');
    expect(upsertedEmits).toHaveLength(1);
    expect(upsertedEmits[0]).toMatchObject({ id: 'sess-live', codexSandbox: 'workspace-write' });
    expect(updateSandboxMode).toHaveBeenCalledWith('workspace-write', {
      networkAccessEnabled: true,
      additionalDirectories: ['/tmp/ref'],
    });
    expect(currentTurn.signal.aborted).toBe(false);
    expect([...internal.pendingTurns].map((entry) => entry.input)).toEqual(['queued-next-turn']);
    expect(bridge.createCalls).toHaveLength(0);
    expect(sessionManager.releaseSdkClaim).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('dormant session: persists DB only and does not create/resume even if jsonl is missing', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-dormant',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
      })
      .mockReturnValue({
        id: 'sess-dormant',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'dormant',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'danger-full-access',
      });

    await expect(
      bridge.setCodexSandbox('sess-dormant', 'danger-full-access'),
    ).resolves.toBeUndefined();

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(1);
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-dormant', 'danger-full-access');
    expect(bridge.createCalls).toHaveLength(0);
  });

  it('waits for an existing same-session recovery before applying the sandbox change', async () => {
    const bridge = makeBridge();
    let releaseRecovery!: () => void;
    const recovering = (bridge as unknown as { recovering: Map<string, Promise<unknown>> }).recovering;
    recovering.set(
      'sess-wait',
      new Promise<void>((resolve) => {
        releaseRecovery = () => {
          recovering.delete('sess-wait');
          resolve();
        };
      }),
    );
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-wait',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'read-only',
    });

    const p = bridge.setCodexSandbox('sess-wait', 'workspace-write');
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionRepo.setCodexSandbox).not.toHaveBeenCalled();

    releaseRecovery();
    await p;
    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sess-wait', 'workspace-write');
  });

  it('forward setCodexSandbox throw → rollback attempt + error bubble + no createSession', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dbfail',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'read-only',
    });
    vi.mocked(sessionRepo.setCodexSandbox)
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      })
      .mockImplementationOnce(() => undefined);

    await expect(
      bridge.setCodexSandbox('sess-dbfail', 'workspace-write'),
    ).rejects.toThrow(/SQLITE_BUSY/);

    const errMsgs = emits.filter(
      (e) =>
        e.kind === 'message' &&
        (e.payload as { error?: boolean }).error === true &&
        ((e.payload as { text?: string }).text ?? '').includes('切到 sandbox'),
    );
    expect(errMsgs).toHaveLength(1);
    expect(bridge.createCalls).toHaveLength(0);
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(2, 'sess-dbfail', 'read-only');
  });

  it('live thread patch throw → rolls back DB and emits reverted session-upserted', async () => {
    const bridge = makeBridge();
    const thread = {
      runStreamed: vi.fn(),
      updateSandboxMode: vi.fn(() => {
        throw new Error('patch failed');
      }),
    } as unknown as InternalSession['thread'];
    const internal = makeInternalSession(thread, 'sess-live-fail');
    const sessionsMap = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    sessionsMap.set('sess-live-fail', internal);

    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
      })
      .mockReturnValueOnce({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'workspace-write',
      })
      .mockReturnValue({
        id: 'sess-live-fail',
        agentId: 'codex-cli',
        cwd: '/tmp/x',
        title: 'x',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'idle',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
        codexSandbox: 'read-only',
      });

    const upsertedEmits: unknown[] = [];
    const spy = vi.spyOn(eventBus, 'emit').mockImplementation((name: string, payload: unknown) => {
      if (name === 'session-upserted') upsertedEmits.push(payload);
      return true;
    });

    await expect(
      bridge.setCodexSandbox('sess-live-fail', 'workspace-write'),
    ).rejects.toThrow(/patch failed/);

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledTimes(2);
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(1, 'sess-live-fail', 'workspace-write');
    expect(sessionRepo.setCodexSandbox).toHaveBeenNthCalledWith(2, 'sess-live-fail', 'read-only');
    expect(upsertedEmits).toHaveLength(2);
    expect(upsertedEmits[0]).toMatchObject({ codexSandbox: 'workspace-write' });
    expect(upsertedEmits[1]).toMatchObject({ codexSandbox: 'read-only' });
    expect(bridge.createCalls).toHaveLength(0);

    spy.mockRestore();
  });

  it('DB/live dual rollback failure reports state unknown and never claims sandbox reverted', async () => {
    const bridge = makeBridge();
    const updateSandboxMode = vi.fn(() => {
      throw new Error('live sandbox projection failed');
    });
    const internal = makeInternalSession({
      runStreamed: vi.fn(),
      updateSandboxMode,
    } as unknown as InternalSession['thread'], 'sess-dual-fail');
    const sessionsMap = (bridge as unknown as {
      sessions: Map<string, InternalSession>;
    }).sessions;
    sessionsMap.set('sess-dual-fail', internal);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dual-fail',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'read-only',
    });
    vi.mocked(sessionRepo.setCodexSandbox)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('DB rollback failed');
      });

    await expect(
      bridge.setCodexSandbox('sess-dual-fail', 'workspace-write'),
    ).rejects.toThrow('live sandbox projection failed');

    expect(updateSandboxMode).toHaveBeenCalledTimes(2);
    const message = emits.find((event) =>
      event.kind === 'message' &&
      (event.payload as { error?: boolean }).error === true);
    const text = (message?.payload as { text?: string } | undefined)?.text ?? '';
    expect(text).toMatch(/回退未完全成功.*当前状态未知/);
    expect(text).not.toContain('档位已回退');
  });

  it('record 不存在 → throw not found', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    await expect(
      bridge.setCodexSandbox('sess-ghost', 'workspace-write'),
    ).rejects.toThrow(/not found in repo/);
  });
});
