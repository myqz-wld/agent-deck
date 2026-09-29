// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { SessionCreationDefaults } from '@shared/types';
import { useSessionCreationOptions } from '../useSessionCreationOptions';
import { setLastDefaults } from '../useLastSessionDefaults';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useRemoteSessionCreation } from '@renderer/components/new-session/useRemoteSessionCreation';
import { submitLocalSession } from '@renderer/components/new-session/session-dialog-actions';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

function configuration(provider: string, thinking: SessionCreationDefaults['thinking']): SessionCreationDefaults {
  return { provider, thinking, model: `${provider || 'native'}-model`, permissionMode: 'bypassPermissions',
    approvalPolicy: 'never', sessionMode: 'default', claudeCodeSandbox: 'workspace-write',
    codexSandbox: 'workspace-write', grokSandbox: 'workspace' };
}

describe('new-session Gateway thinking', () => {
  it.each(['claude-code', 'codex-cli'])(
    'refreshes %s defaults and preserves only the selected Gateway override', async (adapterId) => {
      vi.useFakeTimers();
      for (const provider of ['gateway-a', 'gateway-b', '']) {
        setLastDefaults(adapterId, { provider, model: '', thinking: '' });
      }
      let finish!: (value: SessionCreationDefaults) => void;
      const pending = new Promise<SessionCreationDefaults>((resolve) => { finish = resolve; });
      const read = vi.fn()
        .mockResolvedValueOnce(configuration('', 'medium'))
        .mockResolvedValueOnce(configuration('gateway-a', 'max'))
        .mockReturnValueOnce(pending)
        .mockResolvedValueOnce(configuration('gateway-a', 'max'));
      window.api = { getAdapterSessionCreationDefaults: read,
        listClaudeGatewayProfiles: async () => [], listCodexGatewayProfiles: async () => [],
        createAdapterSession: vi.fn().mockResolvedValue('created-session'),
      } as unknown as typeof window.api;
      const hook = renderHook(() => useSessionCreationOptions({ adapterId, cwd: '/repo' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setThinking('high'));
      act(() => hook.result.current.setProvider('gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.thinking).toBe('max');
      expect(hook.result.current.model).toBe('gateway-a-model');
      await submitLocalSession(adapterId, undefined, hook.result.current, '/repo', 'run task', []);
      expect(window.api.createAdapterSession).toHaveBeenCalledWith(adapterId,
        expect.objectContaining({ provider: 'gateway-a', thinking: 'max' }));
      act(() => hook.result.current.setThinking('low'));
      act(() => hook.result.current.setProvider('gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setThinking('medium'));
      await act(async () => finish(configuration('gateway-b', 'xhigh')));
      expect(hook.result.current.thinking).toBe('medium');
      act(() => hook.result.current.setProvider('gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.thinking).toBe('low');
    },
  );

  it('isolates Remote thinking overrides while refreshing Gateway capability defaults', async () => {
    vi.useFakeTimers();
    const getSessionCapabilities = vi.fn(async ({ provider }: { provider: string }) => {
      const result = sessionConsoleCapabilitiesFixture('claude-code', '.');
      const selected = provider || 'gateway-a';
      result.create.options.provider = { ...result.create.options.provider,
        enabled: true, allowCustom: true, allowEmpty: true, defaultValue: selected };
      result.create.options.thinking = { ...result.create.options.thinking,
        enabled: true, defaultValue: selected === 'gateway-a' ? 'max' : 'xhigh',
        allowedValues: ['low', 'medium', 'high', 'xhigh', 'max'] };
      return result;
    });
    const source = { identity: 'test-remote', usable: true, capabilities: new Set(['session-console.read']),
      getSessionCapabilities } as unknown as RemoteSessionSourceView;
    const hook = renderHook(() => useRemoteSessionCreation({ active: true, scopeKey: 'dialog', source, workingDirectory: '.' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.options.thinking).toBe('max');
    act(() => hook.result.current.setOption('thinking', 'low'));
    act(() => hook.result.current.setOption('provider', 'gateway-b'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.options.thinking).toBe('xhigh');
    act(() => hook.result.current.setOption('provider', 'gateway-a'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.options.thinking).toBe('low');
  });
});
