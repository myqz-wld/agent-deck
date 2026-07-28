import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import { GrokSandboxRestartController } from '../sandbox-restart-controller';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';

function fakeProcess(label: string): GrokAcpProcess {
  return {
    stop: vi.fn(async () => undefined),
    diagnostics: label,
  } as unknown as GrokAcpProcess;
}

function runtime(): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: fakeProcess('old'),
    ready: true,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: null,
    thinking: null,
    sessionMode: null,
    grokSandbox: 'workspace',
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
  };
}

function harness(
  active: GrokRuntime,
  start: (candidate: GrokRuntime) => Promise<boolean>,
) {
  const persist = vi.fn();
  const drain = vi.fn(async () => undefined);
  const dispose = vi.fn(async (candidate: GrokRuntime) => {
    candidate.closed = true;
    candidate.disposed = true;
    candidate.ready = false;
    candidate.process = null;
  });
  const controller = new GrokSandboxRestartController({
    getRuntime: (sessionId) =>
      sessionId === active.applicationSessionId ? active : null,
    start,
    persist,
    drain,
    dispose,
  });
  return { controller, persist, drain, dispose };
}

describe('GrokSandboxRestartController', () => {
  it('restarts an idle runtime and commits only after the target loads', async () => {
    const active = runtime();
    const old = active.process!;
    const start = vi.fn(async (candidate: GrokRuntime) => {
      candidate.process = fakeProcess('strict');
      candidate.ready = true;
      candidate.suppressUpdates = false;
      return true;
    });
    const { controller, persist, drain } = harness(active, start);

    await expect(controller.restart(active.applicationSessionId, ' strict ')).resolves.toBe(
      active.applicationSessionId,
    );

    expect(old.stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(active).toMatchObject({
      grokSandbox: 'strict',
      restartingSandbox: false,
      ready: true,
      nativeSessionId: 'native-session',
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
  });

  it('restores the old profile when target startup fails', async () => {
    const active = runtime();
    const failed = fakeProcess('failed-target');
    const restored = fakeProcess('restored');
    const start = vi
      .fn<(candidate: GrokRuntime) => Promise<boolean>>()
      .mockImplementationOnce(async (candidate) => {
        candidate.process = failed;
        throw new Error('unknown custom profile');
      })
      .mockImplementationOnce(async (candidate) => {
        candidate.process = restored;
        candidate.ready = true;
        candidate.suppressUpdates = false;
        return true;
      });
    const { controller, persist, dispose } = harness(active, start);

    await expect(
      controller.restart(active.applicationSessionId, 'missing-profile'),
    ).rejects.toThrow('已恢复原档位');

    expect(failed.stop).toHaveBeenCalledOnce();
    expect(active.grokSandbox).toBe('workspace');
    expect(active.closed).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects active work and disposes only after target and rollback both fail', async () => {
    const active = runtime();
    active.running = true;
    const idleStart = vi.fn(async () => true);
    const first = harness(active, idleStart);
    await expect(
      first.controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('等待会话空闲');
    expect(idleStart).not.toHaveBeenCalled();

    active.running = false;
    const start = vi.fn(async (candidate: GrokRuntime) => {
      candidate.process = fakeProcess('failed');
      throw new Error(candidate.grokSandbox === 'strict' ? 'target failed' : 'rollback failed');
    });
    const second = harness(active, start);
    await expect(
      second.controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('旧档位恢复也失败');
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(active.closed).toBe(true);
  });

  it('coalesces the same target and rejects a competing target while switching', async () => {
    const active = runtime();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const start = vi.fn(async (candidate: GrokRuntime) => {
      await startGate;
      candidate.process = fakeProcess('strict');
      candidate.ready = true;
      return true;
    });
    const { controller } = harness(active, start);

    const first = controller.restart(active.applicationSessionId, 'strict');
    const same = controller.restart(active.applicationSessionId, ' strict ');
    const competing = controller.restart(active.applicationSessionId, 'read-only');

    expect(same).toBe(first);
    await expect(competing).rejects.toThrow('正在切换中');
    releaseStart();
    await expect(first).resolves.toBe(active.applicationSessionId);
    expect(start).toHaveBeenCalledOnce();
  });

  it('rejects a pending permission without stopping the current process', async () => {
    const active = runtime();
    active.pendingPermissions.set('permission', {} as never);
    const old = active.process!;
    const start = vi.fn(async () => true);
    const { controller } = harness(active, start);

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('授权请求尚未结束');
    expect(old.stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects while a model or mode transaction owns the runtime lease', async () => {
    const active = runtime();
    active.runtimeMutationInProgress = true;
    const old = active.process!;
    const start = vi.fn(async () => true);
    const { controller } = harness(active, start);

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('runtime 设置事务');

    expect(old.stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('disposes truthfully when the old process rejects stop', async () => {
    const active = runtime();
    const old = active.process!;
    vi.mocked(old.stop).mockRejectedValue(new Error('old stop rejected'));
    const { controller, dispose } = harness(active, vi.fn(async () => true));

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('旧 Grok ACP 进程');

    expect(dispose).toHaveBeenCalledOnce();
    expect(active).toMatchObject({
      ready: false,
      restartingSandbox: false,
      closed: true,
      disposed: true,
    });
  });

  it('does not start rollback when the failed target rejects stop', async () => {
    const active = runtime();
    const target = fakeProcess('target');
    vi.mocked(target.stop).mockRejectedValue(new Error('target stop rejected'));
    const start = vi.fn(async (candidate: GrokRuntime) => {
      candidate.process = target;
      throw new Error('target startup failed');
    });
    const { controller, dispose } = harness(active, start);

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('目标 Grok ACP 进程');

    expect(start).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(active.disposed).toBe(true);
  });

  it('disposes after rollback startup and rollback stop both reject', async () => {
    const active = runtime();
    const failedTarget = fakeProcess('target');
    const failedRollback = fakeProcess('rollback');
    vi.mocked(failedRollback.stop).mockRejectedValue(
      new Error('rollback stop rejected'),
    );
    const start = vi
      .fn<(candidate: GrokRuntime) => Promise<boolean>>()
      .mockImplementationOnce(async (candidate) => {
        candidate.process = failedTarget;
        throw new Error('target startup failed');
      })
      .mockImplementationOnce(async (candidate) => {
        candidate.process = failedRollback;
        throw new Error('rollback startup failed');
      });
    const { controller, dispose } = harness(active, start);

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('回滚 Grok ACP 进程');

    expect(failedTarget.stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(active.disposed).toBe(true);
  });

  it('rolls back after target persistence fails', async () => {
    const active = runtime();
    const target = fakeProcess('target');
    const rollback = fakeProcess('rollback');
    const start = vi
      .fn<(candidate: GrokRuntime) => Promise<boolean>>()
      .mockImplementationOnce(async (candidate) => {
        candidate.process = target;
        candidate.ready = true;
        return true;
      })
      .mockImplementationOnce(async (candidate) => {
        candidate.process = rollback;
        candidate.ready = true;
        return true;
      });
    const { controller, persist, dispose } = harness(active, start);
    persist.mockImplementationOnce(() => {
      throw new Error('persist failed');
    });

    await expect(
      controller.restart(active.applicationSessionId, 'strict'),
    ).rejects.toThrow('已恢复原档位');

    expect(target.stop).toHaveBeenCalledOnce();
    expect(active.grokSandbox).toBe('workspace');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });
});
