import { describe, expect, it, vi } from 'vitest';

import {
  issueRemoteOwnerAccessContext,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { AuthoritativeSessionConsolePort } from '@core/session-console';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';

import { SessionConsoleDaemonRuntime } from './session-console-runtime';

function access(topology: 'full' | 'relay'): AuthenticatedClientAccessContext {
  return issueRemoteOwnerAccessContext({
    topology,
    instanceId: 'instance-a',
    clientId: 'client-a',
    connectionScope: 'credential-a',
    surface: 'desktop',
  });
}

function authority(): AuthoritativeSessionConsolePort {
  return {
    listSessions: () => ({ sessions: [], nextCursor: null, total: 0, revision: 4 }),
    getSession: () => ({ session: null, revision: 4 }),
    listProjects: () => ({
      projects: [{ projectId: 'project-a', projectRef: 'opaque-a', alias: 'a', title: 'A' }],
      nextCursor: null,
      total: 1,
      revision: 4,
    }),
    getCapabilities: () => sessionConsoleCapabilitiesFixture(),
    listWorkspaceDirectories: ({ directory }) => ({
      directory, directories: [], truncated: false, revision: 4,
    }),
    createSession: () => ({ sessionId: 'session-a', revision: 5 }),
  };
}

function request(
  method: DaemonRequestInput['method'],
  params: DaemonRequestInput['params'],
  topology: 'full' | 'relay',
): DaemonRequestInput {
  return {
    access: access(topology),
    requestId: 'request-a',
    method,
    params,
    idempotencyKey: method === 'session.console.create' ? 'event-a' : null,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

describe('SessionConsoleDaemonRuntime', () => {
  it.each(['full', 'relay'] as const)(
    'injects the same cwd-free authoritative surface for %s access',
    async (topology) => {
      const execute = vi.fn(async () => ({ result: null, revision: 2 }));
      const base: DaemonCoreRuntime = {
        supportedMethods: ['system.health'],
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        currentRevision: () => 2,
        execute,
      };
      const runtime = new SessionConsoleDaemonRuntime(base, authority());

      await expect(runtime.execute(request('project.list', { limit: 10 }, topology)))
        .resolves.toEqual({
          result: {
            projects: [{
              projectId: 'project-a', projectRef: 'opaque-a', alias: 'a', title: 'A',
            }],
            nextCursor: null,
            total: 1,
            revision: 4,
          },
          revision: 4,
        });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(await runtime.execute(
        request('session.console.list', { limit: 10 }, topology),
      ))).not.toContain('cwd');
    },
  );

  it('delegates non-console methods and preserves optional replay capability exactly', async () => {
    const base: DaemonCoreRuntime = {
      supportedMethods: ['system.health'],
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      currentRevision: () => 2,
      execute: vi.fn(async () => ({ result: { ok: true }, revision: 2 })),
    };
    const runtime = new SessionConsoleDaemonRuntime(base, authority());
    expect(runtime.subscribe).toBeUndefined();
    await expect(runtime.execute(request('system.health', {}, 'full')))
      .resolves.toEqual({ result: { ok: true }, revision: 2 });
    expect(runtime.supportedMethods).toContain('session.console.create');
    expect(runtime.supportedMethods).toContain('session.console.capabilities');
    expect(runtime.supportedMethods).toContain('workspace.directory.list');
  });

  it('rejects cwd-shaped request fields before reaching authority', async () => {
    const listSessions = vi.fn();
    const port = { ...authority(), listSessions };
    const base = {
      supportedMethods: ['system.health'] as const,
      start: async () => undefined,
      stop: async () => undefined,
      currentRevision: () => 0,
      execute: async () => ({ result: null, revision: 0 }),
    } satisfies DaemonCoreRuntime;
    const runtime = new SessionConsoleDaemonRuntime(base, port);
    await expect(runtime.execute(request(
      'session.console.list',
      { limit: 10, cwd: '/private' } as never,
      'full',
    ))).rejects.toMatchObject({ message: 'Request rejected' });
    expect(listSessions).not.toHaveBeenCalled();
  });
});
