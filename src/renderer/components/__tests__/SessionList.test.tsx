// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { SessionList } from '../SessionList';

function makeSession(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo/shared',
    title: `Session ${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  } as SessionRecord;
}

let getSessionGitBranch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSessionGitBranch = vi.fn().mockResolvedValue('feature/session-list');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getSessionGitBranch },
  });
  useSessionStore.setState({
    sessions: new Map(),
    selectedSessionId: null,
    recentEventsBySession: new Map(),
    latestSummaryBySession: new Map(),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('SessionList metadata', () => {
  it('shows branch and context usage while deduplicating branch lookups by cwd', async () => {
    const runtimeIdentity = {
      version: 1 as const,
      runtimeKey: 'codex:openai:gpt-current:default',
      adapter: 'codex-cli' as const,
      runtimeProvider: 'openai',
      model: 'gpt-current',
      capacityConfigFingerprint: 'default',
    };
    const active = makeSession('active', {
      contextUsage: {
        usedTokens: 34_567,
        windowTokens: 272_000,
        updatedAt: 10,
        runtimeIdentity,
      },
    });
    const compacting = makeSession('compacting', {
      lifecycle: 'dormant',
      contextUsage: {
        usedTokens: null,
        windowTokens: 200_000,
        updatedAt: 20,
        runtimeIdentity,
      },
    });
    useSessionStore.setState({
      sessions: new Map([
        [active.id, active],
        [compacting.id, compacting],
      ]),
    });

    render(<SessionList />);

    expect(await screen.findAllByText('分支 feature/session-list')).toHaveLength(2);
    expect(getSessionGitBranch).toHaveBeenCalledTimes(1);
    const contextLabels = screen
      .getAllByLabelText('上下文窗口用量')
      .map((element) => element.textContent);
    expect(contextLabels).toContain('上下文 34.6K / 272K · 12.7%');
    expect(contextLabels).toContain('上下文 更新中 / 200K');

    act(() => {
      useSessionStore.getState().upsertSession({
        ...active,
        contextUsage: {
          usedTokens: null,
          windowTokens: 272_000,
          updatedAt: 30,
          runtimeIdentity,
        },
      });
    });
    expect(screen.getByText('上下文 更新中 / 272K')).toBeTruthy();
    expect(getSessionGitBranch).toHaveBeenCalledTimes(1);
  });
});
