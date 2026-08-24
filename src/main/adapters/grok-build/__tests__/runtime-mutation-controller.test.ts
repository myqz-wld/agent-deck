import { methods } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import {
  GrokRuntimeMutationController,
  GrokRuntimeMutationError,
} from '../runtime-mutation-controller';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';

function runtime(
  request: ReturnType<typeof vi.fn>,
  overrides: Partial<GrokRuntime> = {},
): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: {
      connection: { agent: { request } },
    } as unknown as GrokAcpProcess,
    ready: true,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: 'old-model',
    modelOverride: 'old-model',
    nativeDefaultModel: 'native-model',
    thinking: 'low',
    thinkingOverride: 'low',
    sessionMode: 'default',
    grokSandbox: null,
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
    ...overrides,
    runtimeIdentity: overrides.runtimeIdentity ?? null,
    activeGrokSandbox: overrides.activeGrokSandbox ?? overrides.grokSandbox ?? null,
  };
}

function harness(
  active: GrokRuntime | null,
  overrides: {
    persistModelOptions?: (sessionId: string, model: string | null, thinking: string | null) => void;
    persistSessionMode?: (sessionId: string, mode: 'default' | 'plan' | 'ask') => void;
    persisted?: {
      model: string | null;
      thinking: string | null;
      sessionMode: 'default' | 'plan' | 'ask' | null;
    } | null;
    timeoutMs?: number;
  } = {},
) {
  const persistModelOptions = vi.fn(
    overrides.persistModelOptions ?? (() => undefined),
  );
  const persistSessionMode = vi.fn(
    overrides.persistSessionMode ?? (() => undefined),
  );
  const dispose = vi.fn(async (candidate: GrokRuntime) => {
    candidate.ready = false;
    candidate.closed = true;
    candidate.disposed = true;
    candidate.process = null;
  });
  const drain = vi.fn(async () => undefined);
  const controller = new GrokRuntimeMutationController({
    getRuntime: (sessionId) =>
      active?.applicationSessionId === sessionId ? active : null,
    getPersistedOptions: (sessionId) =>
      sessionId === 'app-session'
        ? overrides.persisted ?? {
            model: active?.modelOverride ?? null,
            thinking: active?.thinkingOverride ?? null,
            sessionMode: active?.sessionMode ?? null,
          }
        : null,
    persistModelOptions,
    persistSessionMode,
    dispose,
    drain,
    requestTimeoutMs: overrides.timeoutMs ?? 25,
  });
  return { controller, persistModelOptions, persistSessionMode, dispose, drain };
}

describe('GrokRuntimeMutationController', () => {
  it('clears persisted overrides using only the ACP-reported native model', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe('session/set_model');
      expect(params).toEqual({
        sessionId: 'native-session',
        modelId: 'native-model',
      });
      return { modelId: 'native-model', reasoningEffort: null };
    });
    const active = runtime(request);
    const { controller, persistModelOptions, drain } = harness(active);

    await controller.setModelOptions('app-session', {
      provider: null,
      model: null,
      thinking: null,
    });

    expect(persistModelOptions).toHaveBeenCalledWith(
      'app-session',
      null,
      null,
    );
    expect(active).toMatchObject({
      model: 'native-model',
      runtimeIdentity: { runtimeProvider: 'native', model: 'native-model' },
      modelOverride: null,
      thinking: null,
      thinkingOverride: null,
    });
    expect(drain).toHaveBeenCalledWith(active);
  });

  it('rejects a clear before touching provider, memory, or DB when ACP reported no default', async () => {
    const request = vi.fn();
    const active = runtime(request, { nativeDefaultModel: null });
    const before = {
      model: active.model,
      modelOverride: active.modelOverride,
      thinking: active.thinking,
      thinkingOverride: active.thinkingOverride,
    };
    const { controller, persistModelOptions, dispose } = harness(active);

    await expect(
      controller.setModelOptions('app-session', {
        provider: null,
        model: null,
        thinking: null,
      }),
    ).rejects.toBeInstanceOf(GrokRuntimeMutationError);

    expect(request).not.toHaveBeenCalled();
    expect(persistModelOptions).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(active).toMatchObject(before);
  });

  it.each(['DB write 1 failed', 'DB write 2 failed'])(
    'rolls the provider back when %s after provider success',
    async (failure) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          modelId: 'new-model',
          reasoningEffort: 'high',
        })
        .mockResolvedValueOnce({
          modelId: 'old-model',
          reasoningEffort: 'low',
        });
      const active = runtime(request);
      let persistCalls = 0;
      const { controller, dispose } = harness(active, {
        persistModelOptions: () => {
          persistCalls += 1;
          if (persistCalls === 1) throw new Error(failure);
        },
      });

      await expect(
        controller.setModelOptions('app-session', {
          provider: null,
          model: 'new-model',
          thinking: 'high',
        }),
      ).rejects.toThrow(failure);

      expect(request).toHaveBeenNthCalledWith(
        2,
        'session/set_model',
        {
          sessionId: 'native-session',
          modelId: 'old-model',
          _meta: { reasoningEffort: 'low' },
        },
        expect.anything(),
      );
      expect(active).toMatchObject({
        model: 'old-model',
        runtimeIdentity: { runtimeProvider: 'native', model: 'old-model' },
        modelOverride: 'old-model',
        thinking: 'low',
        thinkingOverride: 'low',
      });
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it('disposes when provider rollback cannot be proven', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        modelId: 'new-model',
        reasoningEffort: 'high',
      })
      .mockRejectedValueOnce(new Error('rollback rejected'));
    const active = runtime(request);
    const { controller, dispose } = harness(active, {
      persistModelOptions: () => {
        throw new Error('DB failed');
      },
    });

    await expect(
      controller.setModelOptions('app-session', {
        provider: null,
        model: 'new-model',
        thinking: 'high',
      }),
    ).rejects.toMatchObject({ code: 'remote-state-unknown' });

    expect(dispose).toHaveBeenCalledOnce();
    expect(active.disposed).toBe(true);
    expect(active.runtimeIdentity).toBeNull();
  });

  it('disposes with unchanged durable state when the provider rejects the target request', async () => {
    const request = vi.fn().mockRejectedValue(new Error('provider rejected'));
    const active = runtime(request);
    const { controller, persistModelOptions, dispose } = harness(active);

    await expect(
      controller.setModelOptions('app-session', {
        provider: null,
        model: 'new-model',
        thinking: 'high',
      }),
    ).rejects.toMatchObject({ code: 'remote-state-unknown' });

    expect(persistModelOptions).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(active).toMatchObject({
      modelOverride: 'old-model',
      thinkingOverride: 'low',
      disposed: true,
      runtimeIdentity: null,
    });
  });

  it.each(['never', 'late'])(
    'disposes with unchanged memory and DB when set_model resolves %s',
    async (kind) => {
      let resolveRequest!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      const request = vi.fn(() => pending);
      const active = runtime(request);
      const { controller, persistModelOptions, dispose } = harness(active, {
        timeoutMs: 5,
      });

      await expect(
        controller.setModelOptions('app-session', {
          provider: null,
          model: 'new-model',
          thinking: 'high',
        }),
      ).rejects.toMatchObject({ code: 'remote-state-unknown' });
      if (kind === 'late') {
        resolveRequest({ modelId: 'new-model', reasoningEffort: 'high' });
        await Promise.resolve();
      }

      expect(persistModelOptions).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(active).toMatchObject({
        model: 'old-model',
        modelOverride: 'old-model',
        thinking: 'low',
        thinkingOverride: 'low',
        disposed: true,
        runtimeIdentity: null,
      });
    },
  );

  it('persists a dormant selection without resolving or starting a runtime', async () => {
    const { controller, persistModelOptions, dispose } = harness(null, {
      persisted: {
        model: 'old-model',
        thinking: 'low',
        sessionMode: 'default',
      },
    });

    await controller.setModelOptions('app-session', {
      provider: null,
      model: 'new-model',
      thinking: 'high',
    });

    expect(persistModelOptions).toHaveBeenCalledWith(
      'app-session',
      'new-model',
      'high',
    );
    expect(dispose).not.toHaveBeenCalled();
  });

  it('rolls a successful setMode back when persistence fails', async () => {
    const request = vi.fn(async (method: unknown, params: { modeId: string }) => {
      expect(method).toBe(methods.agent.session.setMode);
      expect(['plan', 'default']).toContain(params.modeId);
      return {};
    });
    const active = runtime(request);
    let persistCalls = 0;
    const { controller, dispose } = harness(active, {
      persistSessionMode: () => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error('mode persist failed');
      },
    });

    await expect(controller.setSessionMode('app-session', 'plan')).rejects.toThrow(
      'mode persist failed',
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(active.sessionMode).toBe('default');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('bounds live setMode and restores the prior DB selection before disposal', async () => {
    const request = vi.fn(() => new Promise(() => undefined));
    const active = runtime(request);
    const { controller, persistSessionMode, dispose } = harness(active, {
      timeoutMs: 5,
    });

    await expect(
      controller.setSessionMode('app-session', 'plan'),
    ).rejects.toMatchObject({ code: 'remote-state-unknown' });

    expect(persistSessionMode).toHaveBeenCalledWith(
      'app-session',
      'default',
    );
    expect(active.sessionMode).toBe('default');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
