import { describe, expect, it, vi } from 'vitest';

import { issueRemoteOwnerAccessContext, type AccessContext } from '@contracts/index';
import {
  sessionConsoleCapabilitiesFixture,
  sessionConsoleCreateOptionsFixture,
} from '@contracts/session-console-capabilities.fixture';
import {
  SessionConsoleCoreDispatcher,
  type AuthoritativeSessionConsolePort,
  type SessionConsoleExecutionContext,
} from './session-console';

const serverAccess: AccessContext = issueRemoteOwnerAccessContext({
  topology: 'full',
  instanceId: 'instance-1',
  clientId: 'client-1',
  connectionScope: 'credential-1',
  surface: 'feishu',
});

const desktopAccess: AccessContext = issueRemoteOwnerAccessContext({
  topology: 'full',
  instanceId: 'instance-1',
  clientId: 'client-1',
  connectionScope: 'credential-1',
  surface: 'desktop',
});

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
    listWorkspaceDirectories: ({ directory }) => ({
      directory, directories: [], truncated: false, revision: 1,
    }),
    ...overrides,
    getCapabilities: overrides.getCapabilities ?? (() => sessionConsoleCapabilitiesFixture()),
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

  it('creates by Workspace-relative directory in either topology', async () => {
    const createSession = vi.fn(() => ({ sessionId: 'session-2', revision: 3 }));
    const dispatcher = new SessionConsoleCoreDispatcher(authority({ createSession }));
    const relayAccess: AccessContext = {
      ...serverAccess,
      topology: 'relay',
    };

    await expect(dispatcher.execute(
      'session.console.create',
      {
        adapterId: 'codex-cli',
        attachments: [],
        capabilityRevision: `sha256:${'a'.repeat(64)}`,
        initialMessage: 'Inspect the repository',
        workingDirectory: 'repo/subdir',
        options: sessionConsoleCreateOptionsFixture(),
      },
      context(relayAccess, 'event-1'),
    )).resolves.toEqual({ sessionId: 'session-2', revision: 3 });
    expect(createSession).toHaveBeenCalledWith(
      {
        adapterId: 'codex-cli',
        attachments: [],
        capabilityRevision: `sha256:${'a'.repeat(64)}`,
        initialMessage: 'Inspect the repository',
        workingDirectory: 'repo/subdir',
        options: sessionConsoleCreateOptionsFixture(),
      },
      expect.objectContaining({ access: expect.objectContaining({ topology: 'relay' }) }),
    );
    expect(JSON.stringify(createSession.mock.calls)).not.toContain('cwd');
  });

  it('lists relative Workspace directories for either remote-owner surface', async () => {
    const listWorkspaceDirectories = vi.fn(({ directory }) => ({
      directory,
      directories: [{ directory: 'repo', name: 'repo' }],
      truncated: false,
      revision: 2,
    }));
    const dispatcher = new SessionConsoleCoreDispatcher(authority({ listWorkspaceDirectories }));
    await expect(dispatcher.execute(
      'workspace.directory.list',
      { directory: '.' },
      context(desktopAccess),
    )).resolves.toEqual({
      directory: '.',
      directories: [{ directory: 'repo', name: 'repo' }],
      truncated: false,
      revision: 2,
    });
    await expect(dispatcher.execute(
      'workspace.directory.list',
      { directory: '.' },
      context(serverAccess),
    )).resolves.toEqual({
      directory: '.',
      directories: [{ directory: 'repo', name: 'repo' }],
      truncated: false,
      revision: 2,
    });
    expect(listWorkspaceDirectories).toHaveBeenCalledTimes(2);
  });

  it('rejects absolute or escaping working directories and unknown request fields', async () => {
    const dispatcher = new SessionConsoleCoreDispatcher(authority());
    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', attachments: [], capabilityRevision: 'revision-a', initialMessage: 'Inspect the repository', workingDirectory: '/private/project', options: sessionConsoleCreateOptionsFixture() },
      context(serverAccess, 'event-1'),
    )).rejects.toThrow('Invalid session-console contract field');
    await expect(dispatcher.execute(
      'session.console.create',
      { adapterId: 'codex-cli', attachments: [], capabilityRevision: 'revision-a', initialMessage: 'Inspect the repository', workingDirectory: '../outside', options: sessionConsoleCreateOptionsFixture() },
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
      { adapterId: 'codex-cli', attachments: [], capabilityRevision: 'revision-a', initialMessage: 'Inspect the repository', workingDirectory: '.', options: sessionConsoleCreateOptionsFixture() },
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
      surface: 'relay-worker',
      workerId: 'worker-1',
      generation: 1,
    };
    await expect(
      dispatcher.execute('session.console.list', { limit: 10 }, context(workerAccess)),
    ).rejects.toThrow('Access surface cannot invoke');
    expect(listSessions).not.toHaveBeenCalled();
  });
});
