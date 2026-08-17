import { describe, expect, it, vi } from 'vitest';
import {
  SessionModelControllerCore,
  type SessionModelControllerHost,
  type SessionModelControllerRecord,
} from './session-model-controller-core';

function fixture(record: SessionModelControllerRecord) {
  const current = { ...record };
  const host: SessionModelControllerHost & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  } = {
    read: () => ({ ...current }),
    setRuntimeProvider: (_sessionId, provider) => {
      current.runtimeProvider = provider;
    },
    setModel: (_sessionId, model) => {
      current.model = model;
    },
    setThinking: (_sessionId, thinking) => {
      current.thinking = thinking;
    },
    publishUpdated: vi.fn(),
    now: () => 9_000,
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { current, host };
}

describe('Session model controller Core', () => {
  it('persists dormant selections and releases the exact operation slot', async () => {
    const { current, host } = fixture({
      runtimeProvider: null,
      model: 'old-model',
      thinking: 'low',
    });
    const operations = new Map<string, Promise<unknown>>();
    const applyLive = vi.fn(() => Promise.resolve(false));
    const controller = new SessionModelControllerCore({
      operations,
      agentId: 'claude-core',
      emit: vi.fn(),
      applyLive,
    }, host);

    await controller.setOptions('session-a', {
      provider: 'gateway-a',
      model: 'model-a',
      thinking: 'high',
    });

    expect(current).toEqual({
      runtimeProvider: 'gateway-a',
      model: 'model-a',
      thinking: 'high',
    });
    expect(applyLive).toHaveBeenCalledOnce();
    expect(host.info).toHaveBeenCalledWith(expect.stringContaining('dormant session session-a'));
    expect(operations.size).toBe(0);
  });

  it('rolls back persisted and live state with an injected error event clock', async () => {
    const { current, host } = fixture({
      runtimeProvider: 'gateway-old',
      model: 'model-old',
      thinking: 'low',
    });
    const emit = vi.fn();
    const applyLive = vi.fn()
      .mockRejectedValueOnce(new Error('provider rejected'))
      .mockResolvedValueOnce(true);
    const controller = new SessionModelControllerCore({
      operations: new Map(),
      agentId: 'codex-core',
      emit,
      applyLive,
    }, host);
    const requested = {
      provider: 'gateway-new',
      model: 'model-new',
      thinking: 'high',
    };

    await expect(controller.setOptions('session-a', requested)).rejects.toThrow(
      'provider rejected',
    );

    expect(current).toEqual({
      runtimeProvider: 'gateway-old',
      model: 'model-old',
      thinking: 'low',
    });
    expect(applyLive).toHaveBeenNthCalledWith(2, 'session-a', {
      provider: 'gateway-old',
      model: 'model-old',
      thinking: 'low',
    }, requested);
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      agentId: 'codex-core',
      kind: 'message',
      payload: {
        text: '⚠ 切换模型网关、模型或思考程度失败：provider rejected。已恢复原设置。',
        error: true,
      },
      ts: 9_000,
      source: 'sdk',
    });
  });

  it('rejects a provider switch while working before validation or persistence', async () => {
    const { current, host } = fixture({
      runtimeProvider: 'gateway-old',
      model: 'model-old',
      thinking: 'low',
      activity: 'working',
    });
    const validate = vi.fn();
    const applyLive = vi.fn();
    const controller = new SessionModelControllerCore({
      operations: new Map(),
      agentId: 'claude-core',
      emit: vi.fn(),
      validate,
      applyLive,
    }, host);

    await expect(controller.setOptions('session-a', {
      provider: 'gateway-new',
      model: 'model-new',
      thinking: 'high',
    })).rejects.toThrow('当前回复进行中，暂时不能切换模型网关');

    expect(current.runtimeProvider).toBe('gateway-old');
    expect(validate).not.toHaveBeenCalled();
    expect(applyLive).not.toHaveBeenCalled();
  });

  it('allows adapters to stage a provider switch while a turn is working', async () => {
    const { current, host } = fixture({
      runtimeProvider: 'gateway-old',
      model: 'model-old',
      thinking: 'low',
      activity: 'working',
    });
    const applyLive = vi.fn(() => true);
    const controller = new SessionModelControllerCore({
      operations: new Map(),
      agentId: 'codex-core',
      emit: vi.fn(),
      canStageProviderChange: true,
      applyLive,
    }, host);

    await controller.setOptions('session-a', {
      provider: 'gateway-new',
      model: 'model-new',
      thinking: 'high',
    });

    expect(current).toMatchObject({
      runtimeProvider: 'gateway-new',
      model: 'model-new',
      thinking: 'high',
    });
    expect(applyLive).toHaveBeenCalledOnce();
  });
});
