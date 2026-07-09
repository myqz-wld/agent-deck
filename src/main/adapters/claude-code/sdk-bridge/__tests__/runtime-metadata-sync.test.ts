import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeRuntimeMetadataHooks,
  extractProviderModelAliases,
  syncClaudeRuntimeEffort,
  syncClaudeRuntimeModel,
} from '../runtime-metadata-sync';
import { makeInternalSession } from '../types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

describe('Claude SDK runtime metadata sync', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(sessionRepo.setModel).mockReset();
    vi.mocked(sessionRepo.setThinking).mockReset();
    vi.mocked(eventBus.emit).mockReset();
  });

  it('keeps init model in memory when the DB row has not been finalized yet', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-early' });
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    syncClaudeRuntimeModel(internal, '  claude-opus-4-8  ');

    expect(internal.runtimeModel).toBe('claude-opus-4-8');
    expect(sessionRepo.setModel).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('maps Claude aliases through provider model env without retaining credentials', () => {
    const aliases = extractProviderModelAliases({
      ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_AUTH_TOKEN: 'must-not-be-retained',
    });
    const internal = makeInternalSession({
      cwd: '/repo',
      applicationSid: 'sid-deepseek',
      providerModelAliases: aliases,
    });
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    syncClaudeRuntimeModel(internal, 'claude-haiku-4-5');
    expect(internal.runtimeModel).toBe('deepseek-v4-flash');
    expect(internal.providerModelAliases).toEqual({
      fable: 'deepseek-v4-pro[1m]',
      opus: 'deepseek-v4-pro[1m]',
      sonnet: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-v4-flash',
    });
    expect(internal.providerModelAliases).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('best-effort persists observed model and effort and emits the updated row', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-live' });
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({ id: 'sid-live', model: 'opus', thinking: 'max' } as never)
      .mockReturnValueOnce({ id: 'sid-live', model: 'claude-opus-4-8', thinking: 'max' } as never)
      .mockReturnValueOnce({ id: 'sid-live', model: 'claude-opus-4-8', thinking: 'max' } as never)
      .mockReturnValueOnce({ id: 'sid-live', model: 'claude-opus-4-8', thinking: 'xhigh' } as never);

    syncClaudeRuntimeModel(internal, 'claude-opus-4-8');
    syncClaudeRuntimeEffort(internal, 'xhigh');

    expect(sessionRepo.setModel).toHaveBeenCalledWith('sid-live', 'claude-opus-4-8');
    expect(sessionRepo.setThinking).toHaveBeenCalledWith('sid-live', 'xhigh');
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
    expect(internal.runtimeModel).toBe('claude-opus-4-8');
    expect(internal.runtimeEffort).toBe('xhigh');
  });

  it('retains runtime observations when persistence is unavailable', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-db-error' });
    vi.mocked(sessionRepo.get).mockImplementation(() => {
      throw new Error('db unavailable');
    });

    expect(() => syncClaudeRuntimeModel(internal, 'claude-sonnet-5')).not.toThrow();
    expect(() => syncClaudeRuntimeEffort(internal, 'medium')).not.toThrow();
    expect(internal.runtimeModel).toBe('claude-sonnet-5');
    expect(internal.runtimeEffort).toBe('medium');
  });

  it('Stop and StopFailure hooks only observe valid SDK effort and always return an empty object', async () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-hook' });
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    const hooks = buildClaudeRuntimeMetadataHooks(internal);
    const stop = hooks.Stop![0].hooks[0];
    const stopFailure = hooks.StopFailure![0].hooks[0];
    const options = { signal: new AbortController().signal };

    await expect(
      stop(
        { hook_event_name: 'Stop', effort: { level: 'ultra' } } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBeUndefined();

    await expect(
      stopFailure(
        { hook_event_name: 'StopFailure', effort: { level: 'max' } } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');

    await expect(
      stop(
        {
          hook_event_name: 'Stop',
          agent_id: 'subagent-1',
          effort: { level: 'low' },
        } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');

    await expect(
      stop(
        {
          hook_event_name: 'Stop',
          get effort() {
            throw new Error('malformed hook payload');
          },
        } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');
  });
});
