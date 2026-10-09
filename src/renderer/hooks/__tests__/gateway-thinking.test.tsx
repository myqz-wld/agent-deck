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

describe('new-session Gateway model and thinking memory', () => {
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
        .mockResolvedValueOnce(configuration('gateway-a', 'max'))
        .mockResolvedValueOnce(configuration('', 'medium'))
        .mockResolvedValueOnce(configuration('gateway-b', 'xhigh'))
        .mockResolvedValueOnce(configuration('gateway-b', 'xhigh'))
        .mockResolvedValueOnce(configuration('gateway-a', 'max'));
      window.api = { getAdapterSessionCreationDefaults: read,
        listClaudeGatewayProfiles: async () => [], listCodexGatewayProfiles: async () => [],
        createAdapterSession: vi.fn().mockResolvedValue('created-session'),
      } as unknown as typeof window.api;
      const hook = renderHook(() => useSessionCreationOptions({ adapterId, cwd: '/repo' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setThinking('high'));
      act(() => hook.result.current.setModel('native-custom'));
      act(() => hook.result.current.setProvider('gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.thinking).toBe('max');
      expect(hook.result.current.model).toBe('gateway-a-model');
      await submitLocalSession(adapterId, undefined, hook.result.current, '/repo', 'run task', []);
      expect(window.api.createAdapterSession).toHaveBeenCalledWith(adapterId,
        expect.objectContaining({ provider: 'gateway-a', thinking: 'max' }));
      act(() => hook.result.current.setThinking('low'));
      act(() => hook.result.current.setModel('custom-a'));
      act(() => hook.result.current.setProvider('gateway-b'));
      expect(hook.result.current.model).toBe('');
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setThinking('medium'));
      act(() => hook.result.current.setModel('custom-b'));
      await act(async () => finish(configuration('gateway-b', 'xhigh')));
      expect(hook.result.current.thinking).toBe('medium');
      expect(hook.result.current.model).toBe('custom-b');
      act(() => hook.result.current.setProvider('gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.thinking).toBe('low');
      expect(hook.result.current.model).toBe('custom-a');
      act(() => hook.result.current.setModel(''));
      act(() => hook.result.current.setProvider(''));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.model).toBe('native-custom');
      expect(hook.result.current.thinking).toBe('high');
      act(() => hook.result.current.setProvider('gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.model).toBe('custom-b');
      hook.unmount();
      const reopened = renderHook(() => useSessionCreationOptions({ adapterId, cwd: '/repo' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reopened.result.current.provider).toBe('gateway-b');
      expect(reopened.result.current.model).toBe('custom-b');
      expect(reopened.result.current.thinking).toBe('medium');
      act(() => reopened.result.current.setProvider('gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reopened.result.current.model).toBe('gateway-a-model');
      expect(reopened.result.current.thinking).toBe('low');
    },
  );

  it.each(['claude-code', 'codex-cli'] as const)(
    'isolates Remote %s model and thinking overrides while refreshing Gateway defaults', async (adapterId) => {
      vi.useFakeTimers();
      const getSessionCapabilities = vi.fn(async ({ provider }: { provider: string }) => {
        const result = sessionConsoleCapabilitiesFixture(adapterId, '.');
        const selected = provider || 'gateway-a';
        result.create.options.provider = { ...result.create.options.provider,
          enabled: true, allowCustom: true, allowEmpty: true, defaultValue: selected };
        result.create.options.thinking = { ...result.create.options.thinking,
          enabled: true, defaultValue: selected === 'gateway-a' ? 'max' : 'xhigh',
          allowedValues: ['low', 'medium', 'high', 'xhigh', 'max'] };
        result.create.options.model = { ...result.create.options.model,
          defaultValue: `${selected}-model`, allowCustom: true };
        return result;
      });
      const source = { identity: 'test-remote', usable: true, capabilities: new Set(['session-console.read']),
        getSessionCapabilities } as unknown as RemoteSessionSourceView;
      const hook = renderHook(({ currentSource }) => useRemoteSessionCreation({
        active: true, scopeKey: 'dialog', source: currentSource, workingDirectory: '.',
      }), { initialProps: { currentSource: source } });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.thinking).toBe('max');
      act(() => hook.result.current.setOption('thinking', 'low'));
      act(() => hook.result.current.setOption('model', 'custom-a'));
      act(() => hook.result.current.setOption('provider', 'gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.thinking).toBe('xhigh');
      expect(hook.result.current.options.model).toBe('gateway-b-model');
      act(() => hook.result.current.setOption('model', 'custom-b'));
      act(() => hook.result.current.setOption('provider', 'gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.thinking).toBe('low');
      expect(hook.result.current.options.model).toBe('custom-a');
      act(() => hook.result.current.setOption('provider', 'gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.model).toBe('custom-b');
      act(() => hook.result.current.setOption('model', ''));
      act(() => hook.result.current.setOption('provider', 'gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.model).toBe('custom-a');
      act(() => hook.result.current.setOption('provider', 'gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.model).toBe('gateway-b-model');
      hook.rerender({ currentSource: { ...source, identity: 'another-remote' } });
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setOption('provider', 'gateway-b'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      act(() => hook.result.current.setOption('provider', 'gateway-a'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(hook.result.current.options.model).toBe('gateway-a-model');
      expect(hook.result.current.options.thinking).toBe('max');
    },
  );
});
