// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred } from './use-remote-session-source-test-fixture';
import { useRemoteTaskRecords } from './use-remote-task-records';

function task(sessionId: string, subject: string) {
  return {
    id: `task-${sessionId}`,
    ownerSessionId: sessionId,
    teamId: null,
    subject,
    description: null,
    status: 'active' as const,
    activeForm: null,
    priority: 5,
    blocks: [],
    blockedBy: [],
    labels: [],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:01:00.000Z',
  };
}

afterEach(() => Reflect.deleteProperty(window, 'api'));

describe('useRemoteTaskRecords', () => {
  it('clears the previous session value while the next target loads or fails', async () => {
    const next = deferred<{ tasks: ReturnType<typeof task>[]; revision: number }>();
    let calls = 0;
    window.api = {
      listRemoteHostTasks: vi.fn(async () => ++calls === 1
        ? { tasks: [task('session-a', 'task A')], revision: 1 }
        : next.promise),
    } as unknown as typeof window.api;
    const base = {
      activeProfileId: 'remote-a',
      capabilities: new Set(['tasks']),
      dataRevision: 1,
      identity: 'remote-a:core-a:1',
      usable: true,
    };
    const hook = renderHook((props: typeof base & { selectedSessionId: string }) =>
      useRemoteTaskRecords(props), {
      initialProps: { ...base, selectedSessionId: 'session-a' },
    });
    await waitFor(() => expect(hook.result.current.value?.tasks[0]?.subject).toBe('task A'));

    hook.rerender({ ...base, selectedSessionId: 'session-b' });
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.value).toBeNull();

    next.reject(new Error('tasks unavailable'));
    await act(async () => { await next.promise.catch(() => undefined); });
    expect(hook.result.current).toEqual({ error: 'tasks unavailable', value: null });
  });
});
