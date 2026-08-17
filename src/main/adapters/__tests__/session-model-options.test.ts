import { beforeEach, describe, expect, it, vi } from 'vitest';

const { record, upsertEmit } = vi.hoisted(() => ({
  record: {
    id: 'session-1',
    runtimeProvider: null as string | null,
    model: 'old-model' as string | null,
    thinking: 'low' as string | null,
  },
  upsertEmit: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (id: string) => (id === record.id ? { ...record } : null),
    setModel: (_id: string, value: string | null) => {
      record.model = value;
    },
    setRuntimeProvider: (_id: string, value: string | null) => {
      record.runtimeProvider = value;
    },
    setThinking: (_id: string, value: string | null) => {
      record.thinking = value;
    },
  },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: upsertEmit } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import {
  normalizeSessionModelOptions,
  resolveCreateSessionModelOptions,
  SessionModelOptionsError,
} from '../session-model-options';
import { SessionModelController } from '../session-model-controller';

describe('session model option normalization', () => {
  it('keeps provider and model ids open-ended and trims them for creation', () => {
    expect(
      resolveCreateSessionModelOptions('claude-code', {
        provider: '  deepseek ',
        model: '  deepseek-v4-pro[1m] ',
        thinking: 'max',
      }),
    ).toEqual({
      gateway: 'deepseek',
      model: 'deepseek-v4-pro[1m]',
      claudeCodeEffortLevel: 'max',
    });
    expect(
      resolveCreateSessionModelOptions('codex-cli', {
        provider: '  team.alpha ',
        model: 'provider/custom-model',
        thinking: 'ultra',
      }),
    ).toEqual({
      provider: 'team.alpha',
      model: 'provider/custom-model',
      modelReasoningEffort: 'ultra',
    });
  });

  it('requires Codex Gateway ids to be safe TOML filename stems', () => {
    expect(() =>
      normalizeSessionModelOptions('codex-cli', { provider: 'gateway/edge' }),
    ).toThrow(/有效的 Codex 模型网关/);
  });

  it('rejects an adapter-invalid thinking value', () => {
    expect(() =>
      normalizeSessionModelOptions('claude-code', { thinking: 'ultra' }),
    ).toThrow(SessionModelOptionsError);
    expect(() =>
      normalizeSessionModelOptions('codex-cli', { thinking: 'minimal' }),
    ).toThrow(SessionModelOptionsError);
  });

  it('names Grok Build exactly when rejecting a provider override', () => {
    try {
      normalizeSessionModelOptions('grok-build', { provider: 'xai' });
      expect.unreachable('expected the Grok Build provider override to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionModelOptionsError);
      expect((error as SessionModelOptionsError).field).toBe('provider');
      expect((error as Error).message).toBe(
        'Grok Build 不支持 provider；请选择 Grok Build 模型别名',
      );
    }
  });
});

describe('SessionModelController', () => {
  beforeEach(() => {
    record.runtimeProvider = null;
    record.model = 'old-model';
    record.thinking = 'low';
    upsertEmit.mockClear();
  });

  it('persists and applies a live next-turn selection', async () => {
    const applyLive = vi.fn().mockResolvedValue(true);
    const emit = vi.fn();
    const controller = new SessionModelController({
      operations: new Map(),
      agentId: 'codex-cli',
      emit,
      applyLive,
    });

    await controller.setOptions('session-1', {
      provider: 'custom',
      model: 'new-model',
      thinking: 'high',
    });

    expect(record).toMatchObject({
      runtimeProvider: 'custom',
      model: 'new-model',
      thinking: 'high',
    });
    expect(applyLive).toHaveBeenCalledWith('session-1', {
      provider: 'custom',
      model: 'new-model',
      thinking: 'high',
    }, {
      provider: null,
      model: 'old-model',
      thinking: 'low',
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('rolls DB and live settings back when the provider rejects the change', async () => {
    const applyLive = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported effort'))
      .mockResolvedValueOnce(true);
    const emit = vi.fn();
    const controller = new SessionModelController({
      operations: new Map(),
      agentId: 'claude-code',
      emit,
      applyLive,
    });

    await expect(
      controller.setOptions('session-1', {
        provider: 'custom',
        model: 'new-model',
        thinking: 'max',
      }),
    ).rejects.toThrow('unsupported effort');

    expect(record).toMatchObject({ model: 'old-model', thinking: 'low' });
    expect(applyLive).toHaveBeenNthCalledWith(2, 'session-1', {
      provider: null,
      model: 'old-model',
      thinking: 'low',
    }, {
      provider: 'custom',
      model: 'new-model',
      thinking: 'max',
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        payload: expect.objectContaining({ error: true }),
      }),
    );
  });

  it('rejects an invalid selection before changing persisted or live state', async () => {
    const validate = vi.fn(() => {
      throw new Error('所选模型网关不存在');
    });
    const applyLive = vi.fn();
    const emit = vi.fn();
    const controller = new SessionModelController({
      operations: new Map(),
      agentId: 'codex-cli',
      emit,
      validate,
      applyLive,
    });

    await expect(
      controller.setOptions('session-1', {
        provider: 'missing',
        model: 'new-model',
        thinking: 'high',
      }),
    ).rejects.toThrow('所选模型网关不存在');

    expect(validate).toHaveBeenCalledWith(
      'session-1',
      { provider: 'missing', model: 'new-model', thinking: 'high' },
      { provider: null, model: 'old-model', thinking: 'low' },
    );
    expect(record).toMatchObject({
      runtimeProvider: null,
      model: 'old-model',
      thinking: 'low',
    });
    expect(applyLive).not.toHaveBeenCalled();
    expect(upsertEmit).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: expect.stringContaining('原设置未变。') }),
      }),
    );
  });

  it('rejects a live provider switch before changing DB or live thread state', async () => {
    record.runtimeProvider = 'working-provider';
    const validate = vi.fn(() => {
      throw new Error('当前 Codex 版本不支持为已加载的会话切换模型网关');
    });
    const applyLive = vi.fn();
    const controller = new SessionModelController({
      operations: new Map(),
      agentId: 'codex-cli',
      emit: vi.fn(),
      validate,
      applyLive,
    });

    await expect(controller.setOptions('session-1', {
      provider: 'new-provider',
      model: 'new-model',
      thinking: 'high',
    })).rejects.toThrow(/不支持.*切换模型网关/);

    expect(record).toMatchObject({
      runtimeProvider: 'working-provider',
      model: 'old-model',
      thinking: 'low',
    });
    expect(applyLive).not.toHaveBeenCalled();
    expect(upsertEmit).not.toHaveBeenCalled();
  });
});
