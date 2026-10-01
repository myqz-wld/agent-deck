// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteHostSessionMessagesDto } from '@shared/remote-host';
import { source } from './remote-dialogs-test-fixture';
import { deferred, session } from './use-remote-session-source-test-fixture';
import { useRemoteSessionTabData } from './use-remote-session-tab-data';

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'api'); });

it('retains revisited messages and fences a retired panel response from the shared cache', async () => {
  const old = deferred<RemoteHostSessionMessagesDto>();
  const read = vi.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ sessionId: 'session-a', messages: [], truncated: false, revision: 2 })
    .mockReturnValue(new Promise(() => undefined));
  window.api = { listRemoteHostSessionMessages: read } as unknown as Window['api'];
  const remote = { ...source(), selectedSessionId: 'session-a', selectedSession: session('session-a', 'Test'),
    capabilities: new Set(['sessions.messages.read']) };
  const first = renderHook(() => useRemoteSessionTabData(remote, 'messages'));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useRemoteSessionTabData(remote, 'messages'));
  await waitFor(() => expect(second.result.current.messages.value?.revision).toBe(2));
  second.unmount();
  await act(async () => old.resolve({ sessionId: 'session-a', messages: [], truncated: false, revision: 1 }));
  const third = renderHook(() => useRemoteSessionTabData(remote, 'messages'));
  expect(third.result.current.messages.value?.revision).toBe(2);
  expect(third.result.current.messages.loading).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
});
