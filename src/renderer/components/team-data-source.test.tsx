// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useSessionStore } from '@renderer/stores/session-store';
import type { SessionRecord } from '@shared/types';
import { useTeamDataSource } from './team-data-source';

function session(id: string): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/workspace',
    title: id,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
  };
}

afterEach(() => {
  cleanup();
  act(() => useSessionStore.getState().setSessions([]));
});

describe('Team data-source isolation', () => {
  it('keeps the Remote adapter stable when unrelated Local sessions change', () => {
    const remote = {
      identity: 'remote-a:core-a:1',
      dataRevision: 4,
      profile: { id: 'remote-a' },
    } as unknown as RemoteSessionSourceView;
    const hook = renderHook(() => useTeamDataSource(remote));
    const first = hook.result.current;

    act(() => useSessionStore.getState().setSessions([session('local-only')]));

    expect(hook.result.current).toBe(first);
    expect(hook.result.current.identity).toBe('remote-a:core-a:1');
  });

  it('rebuilds the Remote adapter only for an authoritative Remote revision', () => {
    const makeRemote = (dataRevision: number) => ({
      identity: 'remote-a:core-a:1',
      dataRevision,
      profile: { id: 'remote-a' },
      capabilities: new Set(['teams']),
      selectSession: vi.fn(),
    }) as unknown as RemoteSessionSourceView;
    const hook = renderHook(
      ({ source }) => useTeamDataSource(source),
      { initialProps: { source: makeRemote(4) } },
    );
    const first = hook.result.current;
    hook.rerender({ source: makeRemote(5) });
    expect(hook.result.current).not.toBe(first);
    expect(hook.result.current.revision).toBe(5);
  });
});
