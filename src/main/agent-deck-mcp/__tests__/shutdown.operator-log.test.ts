import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  close: vi.fn(async () => undefined),
  info: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sessionId: string) => mocks.sessions.get(sessionId) ?? null,
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: { close: mocks.close },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ info: mocks.info }),
  },
}));

import { shutdownSessionHandler } from '../tools/handlers/shutdown';

function session(id: string): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.clear();
  mocks.sessions.set('caller-sid', session('caller-sid'));
  mocks.sessions.set('target-sid', session('target-sid'));
});

describe('shutdown_session operator logging', () => {
  it.each([
    ['supplied', 'maintenance requested by lead'],
    ['omitted', undefined],
  ] as const)('records a %s reason without changing shutdown behavior', async (_case, reason) => {
    const result = await shutdownSessionHandler(
      {
        sessionId: 'target-sid',
        ...(reason === undefined ? {} : { reason }),
      },
      {
        caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(mocks.close).toHaveBeenCalledWith('target-sid');
    expect(mocks.info).toHaveBeenCalledWith(
      '[mcp shutdown_session] shutdown requested',
      {
        callerSessionId: 'caller-sid',
        targetSessionId: 'target-sid',
        reason: reason ?? null,
      },
    );
  });
});
