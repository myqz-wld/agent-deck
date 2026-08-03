import { describe, expect, it, vi } from 'vitest';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import {
  CodexRuntimeIdentityTracker,
  applyCodexRuntimeIdentityNotification,
  resolveCodexThreadRuntimeIdentity,
} from './runtime-identity';

const options: CodexThreadOptions = {
  workingDirectory: '/repo',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  skipGitRepoCheck: true,
};

describe('Codex app-server runtime identity', () => {
  it('uses only the effective model/provider returned by the native thread boundary', () => {
    expect(resolveCodexThreadRuntimeIdentity({
      thread: { id: 'thread-1', modelProvider: 'native-fallback' },
      model: 'effective-model',
      modelProvider: 'openrouter',
    }, options, null)).toEqual({
      runtimeProvider: 'openrouter',
      model: 'effective-model',
    });

    expect(resolveCodexThreadRuntimeIdentity({
      thread: { id: 'thread-1', modelProvider: 'native-fallback' },
    }, { ...options, model: 'configured-but-unproved' }, null)).toBeNull();
  });

  it('fingerprints an explicit effective model-context-window config without changing it', () => {
    expect(resolveCodexThreadRuntimeIdentity({
      thread: { id: 'thread-1' },
      model: 'gpt-custom',
      modelProvider: 'custom-provider',
    }, {
      ...options,
      configOverrides: { model_context_window: 272_000 },
    }, null)).toEqual({
      runtimeProvider: 'custom-provider',
      model: 'gpt-custom',
      capacityConfigFingerprint: 'model-context-window:272000',
    });
  });

  it('keeps provider namespaces distinct for the same model name and capacity', () => {
    const openai = resolveCodexThreadRuntimeIdentity({
      thread: { id: 'thread-openai' },
      model: 'shared-model',
      modelProvider: 'openai',
    }, options, null);
    const local = resolveCodexThreadRuntimeIdentity({
      thread: { id: 'thread-local' },
      model: 'shared-model',
      modelProvider: 'local',
    }, options, null);

    expect(openai).toEqual({ runtimeProvider: 'openai', model: 'shared-model' });
    expect(local).toEqual({ runtimeProvider: 'local', model: 'shared-model' });
    expect(openai).not.toEqual(local);
  });

  it('accepts exact settings and reroute notifications but rejects incomplete settings', () => {
    const settings = applyCodexRuntimeIdentityNotification(null, {
      method: 'thread/settings/updated',
      params: {
        threadSettings: { model: 'effective-v2', modelProvider: 'provider-v2' },
      },
    }, 'model-context-window:400000');

    expect(settings).toEqual({
      runtimeProvider: 'provider-v2',
      model: 'effective-v2',
      capacityConfigFingerprint: 'model-context-window:400000',
    });
    expect(applyCodexRuntimeIdentityNotification(settings, {
      method: 'model/rerouted',
      params: { toModel: 'effective-v2-fallback' },
    })).toEqual({
      runtimeProvider: 'provider-v2',
      model: 'effective-v2-fallback',
      capacityConfigFingerprint: 'model-context-window:400000',
    });
    expect(applyCodexRuntimeIdentityNotification(settings, {
      method: 'thread/settings/updated',
      params: { threadSettings: { model: 'missing-provider' } },
    })).toBeNull();
  });

  it('restores the previous identity when a settings request fails without intervening evidence', async () => {
    const tracker = new CodexRuntimeIdentityTracker(null, options, {
      thread: { id: 'thread-1' },
      model: 'gpt-old',
      modelProvider: 'openai',
    });
    const client = {
      subscribe: vi.fn(() => vi.fn()),
      request: vi.fn().mockRejectedValue(new Error('settings rejected')),
    } as unknown as CodexAppServerClient;

    await expect(tracker.updateModelSettings(
      client, 'thread-1', options, 'gpt-new', null,
    )).rejects.toThrow('settings rejected');

    expect(tracker.snapshot()).toEqual({
      runtimeProvider: 'openai',
      model: 'gpt-old',
    });
  });

  it('does not resurrect the previous identity after an ambiguous reroute', async () => {
    const tracker = new CodexRuntimeIdentityTracker(null, options, {
      thread: { id: 'thread-1' },
      model: 'gpt-old',
      modelProvider: 'openai',
    });
    const client = {
      subscribe: vi.fn(() => vi.fn()),
      request: vi.fn().mockImplementation(async () => {
        tracker.observeUnscopedReroute({
          method: 'model/rerouted',
          params: { toModel: 'gpt-rerouted' },
        }, false);
        throw new Error('settings rejected');
      }),
    } as unknown as CodexAppServerClient;

    await expect(tracker.updateModelSettings(
      client, 'thread-1', options, 'gpt-new', null,
    )).rejects.toThrow('settings rejected');

    expect(tracker.snapshot()).toBeNull();
  });

  it('does not overwrite a newer invalidation when a settings request succeeds', async () => {
    const tracker = new CodexRuntimeIdentityTracker(null, options, {
      thread: { id: 'thread-1' },
      model: 'gpt-old',
      modelProvider: 'openai',
    });
    let settingsListener: ((notification: {
      method: string;
      params?: unknown;
    }) => void) | null = null;
    const client = {
      subscribe: vi.fn((listener) => {
        settingsListener = listener;
        return vi.fn();
      }),
      request: vi.fn().mockImplementation(async () => {
        settingsListener?.({
          method: 'thread/settings/updated',
          params: {
            threadId: 'thread-1',
            threadSettings: { model: 'gpt-new', modelProvider: 'openai' },
          },
        });
        tracker.observeUnscopedReroute({
          method: 'model/rerouted',
          params: { toModel: 'gpt-rerouted' },
        }, false);
      }),
    } as unknown as CodexAppServerClient;

    await tracker.updateModelSettings(
      client, 'thread-1', options, 'gpt-new', null,
    );

    expect(tracker.snapshot()).toBeNull();
  });
});
