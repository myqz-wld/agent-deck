import { describe, expect, it, vi } from 'vitest';
import type { AgentCwdTransition } from '@main/adapters/types';
import type { GrokRuntime } from '../runtime-types';
import { GrokCwdTransitionController } from '../cwd-transition-controller';

function transition(): AgentCwdTransition {
  return {
    sessionId: 'session-a',
    generation: 8,
    direction: 'enter',
    fromCwd: '/repo',
    targetCwd: '/repo/worktree',
    continuationKey: 'cwd:test:8',
    continuationText: 'continue',
  };
}

function runtime(): GrokRuntime {
  return {
    applicationSessionId: 'session-a',
    nativeSessionId: 'native-a',
    cwd: '/repo',
    process: { stop: vi.fn(async () => {}) },
    ready: true,
    queue: [],
    submittingMessage: null,
    running: false,
    currentTurnController: null,
    cwdTransitionGeneration: null,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: null,
    thinking: null,
    sessionMode: null,
    grokSandbox: null,
    restartingSandbox: false,
    runtimeMutationInProgress: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: {},
  } as unknown as GrokRuntime;
}

function controllerFor(
  live: GrokRuntime,
  start: (runtime: GrokRuntime) => Promise<boolean>,
) {
  const dispose = vi.fn(async (target: GrokRuntime) => {
    target.disposed = true;
    target.closed = true;
  });
  const drain = vi.fn(async () => {});
  const cancelPermissions = vi.fn((target: GrokRuntime) => {
    target.pendingPermissions.clear();
  });
  const enqueue = vi.fn(
    (
      target: GrokRuntime,
      text: string,
      _attachments: unknown,
      options: { idempotencyKey?: string },
    ) => {
      if (
        options.idempotencyKey &&
        target.acceptedEnqueueFingerprints.has(options.idempotencyKey)
      ) {
        return;
      }
      if (options.idempotencyKey) {
        target.acceptedEnqueueFingerprints.set(
          options.idempotencyKey,
          text,
        );
      }
      target.queue.push({ id: String(target.queue.length + 1), text });
    },
  );
  return {
    dispose,
    drain,
    enqueue,
    cancelPermissions,
    controller: new GrokCwdTransitionController({
      getRuntime: () => live,
      start,
      dispose,
      drain,
      cancelPermissions,
      turnQueue: { enqueue } as any,
    }),
  };
}

describe('GrokCwdTransitionController', () => {
  it('stops the old ACP process, loads the same native session at target cwd, then drains', async () => {
    const live = runtime();
    live.pendingPermissions.set('pending', {} as any);
    const sourceProcess = live.process;
    const start = vi.fn(async (target: GrokRuntime) => {
      target.process = { stop: vi.fn(async () => {}) } as any;
      target.ready = true;
      return true;
    });
    const harness = controllerFor(live, start);

    harness.controller.arm(transition());
    await harness.controller.switchCwd(transition());
    harness.controller.enqueueContinuation(transition(), 'continue');
    harness.controller.enqueueContinuation(transition(), 'continue');

    expect(sourceProcess?.stop).toHaveBeenCalledOnce();
    expect(harness.cancelPermissions).toHaveBeenCalledWith(live);
    expect(start).toHaveBeenCalledWith(live);
    expect(live.cwd).toBe('/repo/worktree');
    expect(live.queue.map((message) => message.text)).toEqual(['continue']);
    expect(harness.drain).not.toHaveBeenCalled();

    harness.controller.release('session-a', 8);
    expect(live.cwdTransitionGeneration).toBeNull();
    expect(harness.drain).toHaveBeenCalledWith(live);
  });

  it('reloads the source cwd when target load fails', async () => {
    const live = runtime();
    const start = vi.fn(async (target: GrokRuntime) => {
      if (target.cwd === '/repo/worktree') return false;
      target.process = { stop: vi.fn(async () => {}) } as any;
      target.ready = true;
      return true;
    });
    const harness = controllerFor(live, start);
    harness.controller.arm(transition());

    await expect(harness.controller.switchCwd(transition())).rejects.toThrow(
      '已恢复 /repo',
    );
    expect(start).toHaveBeenCalledTimes(2);
    expect(live.cwd).toBe('/repo');
    expect(live.disposed).toBe(false);
  });

  it('disposes unknown runtime ownership when target and rollback both fail', async () => {
    const live = runtime();
    const harness = controllerFor(live, async () => false);
    harness.controller.arm(transition());

    await expect(harness.controller.switchCwd(transition())).rejects.toThrow(
      '旧 cwd 恢复也失败',
    );
    expect(harness.dispose).toHaveBeenCalledWith(live);
    expect(live.disposed).toBe(true);
  });

  it('disposes unknown ownership when a half-started target process cannot stop', async () => {
    const live = runtime();
    const start = vi.fn(async (target: GrokRuntime) => {
      target.process = {
        stop: vi.fn(async () => {
          throw new Error('target stop unknown');
        }),
      } as any;
      throw new Error('target load failed');
    });
    const harness = controllerFor(live, start);
    harness.controller.arm(transition());

    await expect(harness.controller.switchCwd(transition())).rejects.toThrow(
      '半启动进程停止结果无法确认',
    );
    expect(harness.dispose).toHaveBeenCalledWith(live);
    expect(live.disposed).toBe(true);
    expect(live.runtimeMutationInProgress).toBe(false);
  });
});
