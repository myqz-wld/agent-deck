import { describe, expect, it, vi } from 'vitest';

import type { AccessContext } from '@contracts/index';
import {
  SessionConsoleCoreDispatcher,
  type AuthoritativeSessionConsolePort,
  type SessionConsoleExecutionContext,
} from './session-console';

const serverAccess: AccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-1',
  clientId: 'client-1',
  transport: 'feishu',
  accessCredentialId: 'credential-1',
  authority: 'owner-equivalent',
  surface: 'feishu-session-console',
};

function context(
  access: AccessContext = serverAccess,
  idempotencyKey: string | null = null,
): SessionConsoleExecutionContext {
  return {
    access,
    idempotencyKey,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function authority(
  overrides: Partial<AuthoritativeSessionConsolePort> = {},
): AuthoritativeSessionConsolePort {
  return {
    listSessions: () => ({ sessions: [], nextCursor: null, total: 0, revision: 1 }),
    getSession: () => ({ session: null, revision: 1 }),
    listProjects: () => ({ projects: [], nextCursor: null, total: 0, revision: 1 }),
    resolveProject: () => ({
      project: {
        projectId: 'project-1',
        projectRef: 'opaque-project-1',
        alias: 'project',
        title: 'Project',
      },
      revision: 1,
    }),
    createSession: () => ({ sessionId: 'session-1', revision: 2 }),
    ...overrides,
  };
}

describe('SessionConsoleCoreDispatcher', () => {
  it('keeps cwd out of the list/get projection', async () => {
    const dispatcher = new SessionConsoleCoreDispatcher(authority({
      listSessions: () => ({
        sessions: [{
          id: 'session-1', adapterId: 'codex-cli', title: null, status: 'idle',
          createdAt: 1, updatedAt: 2, cwd: '/private/workspace',
        }],
        nextCursor: null,
        total: 1,
        revision: 2,
      }),
    }));

    await expect(
      dispatcher.execute('session.console.list', { limit: 10 }, context()),
    ).rejects.toThrow('Invalid session-console contract field');
  });

  it('resolves suggestions and creates by Workspace-relative directory in either topology', async () => {
    const createSession = vi.fn(() => ({ sessionId: 'session-2', revision: 3 }));
    const dispatcher = new SessionConsoleCoreDispatcher(authority({ createSession }));
    const relayAccess: AccessContext = {
      ...serverAccess,
      topology: 'relay',
    };

    const project = await dispatcher.execute(
      'project.resolve',
      { alias: 'project' },
      context(relayAccess),
    );
    expect(JSON.stringify(project)).not.toContain('/');

    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: 'repo/subdir', options: {} },
      context(relayAccess, 'event-1'),
    )).resolves.toEqual({ sessionId: 'session-2', revision: 3 });
    expect(createSession).toHaveBeenCalledWith(
      { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: 'repo/subdir', options: {} },
      expect.objectContaining({ access: expect.objectContaining({ topology: 'relay' }) }),
    );
    expect(JSON.stringify(createSession.mock.calls)).not.toContain('cwd');
  });

  it('rejects absolute or escaping working directories and unknown request fields', async () => {
    const dispatcher = new SessionConsoleCoreDispatcher(authority());
    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: '/private/project', options: {} },
      context(serverAccess, 'event-1'),
    )).rejects.toThrow('Invalid session-console contract field');
    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: '../outside', options: {} },
      context(serverAccess, 'event-2'),
    )).rejects.toThrow('Invalid session-console contract field');
    await expect(dispatcher.execute(
      'session.console.list',
      { limit: 10, cwd: '/private/project' },
      context(),
    )).rejects.toThrow('Invalid session-console contract field');
  });

  it('enforces page limits and mutation idempotency before authority calls', async () => {
    const listSessions = vi.fn();
    const createSession = vi.fn();
    const dispatcher = new SessionConsoleCoreDispatcher(authority({
      listSessions,
      createSession,
    }));
    await expect(
      dispatcher.execute('session.console.list', { limit: 101 }, context()),
    ).rejects.toThrow('Invalid session-console contract field');
    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: '.', options: {} },
      context(),
    )).rejects.toThrow('requires a stable idempotency key');
    expect(listSessions).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects the Relay Worker attachment surface before authority dispatch', async () => {
    const listSessions = vi.fn();
    const dispatcher = new SessionConsoleCoreDispatcher(authority({ listSessions }));
    const workerAccess: AccessContext = {
      kind: 'relay-worker',
      topology: 'relay',
      instanceId: 'instance-1',
      clientId: 'worker-client-1',
      transport: 'ssh',
      accessCredentialId: 'worker-credential-1',
      credentialKind: 'relay-worker',
      authority: 'worker-attach-only',
      surface: 'relay-worker-attach',
      workerId: 'worker-1',
      generation: 1,
    };
    await expect(
      dispatcher.execute('session.console.list', { limit: 10 }, context(workerAccess)),
    ).rejects.toThrow('Access surface cannot invoke');
    expect(listSessions).not.toHaveBeenCalled();
  });
});
