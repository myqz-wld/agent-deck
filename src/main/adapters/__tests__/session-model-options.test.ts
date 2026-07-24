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
      provider: 'deepseek',
      model: 'deepseek-v4-pro[1m]',
      claudeCodeEffortLevel: 'max',
    });
    expect(
      resolveCreateSessionModelOptions('codex-cli', {
        model: 'provider/custom-model',
        thinking: 'ultra',
      }),
    ).toEqual({
      model: 'provider/custom-model',
      modelReasoningEffort: 'ultra',
    });
  });

  it('rejects an adapter-invalid thinking value', () => {
    expect(() =>
      normalizeSessionModelOptions('claude-code', { thinking: 'ultra' }),
    ).toThrow(SessionModelOptionsError);
    expect(() =>
      normalizeSessionModelOptions('codex-cli', { thinking: 'minimal' }),
    ).toThrow(SessionModelOptionsError);
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
});
