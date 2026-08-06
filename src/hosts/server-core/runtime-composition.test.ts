import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseProjectListResult,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';
import type { DaemonInstancePaths } from '@hosts/daemon';
import type { ServerCoreRuntimeFactoryInput } from './root';
import { createServerCoreRuntimeWithOverrides } from './runtime-composition';

const INSTANCE_ID = 'instance-a';
const PROCESS_ID = 'instance-a:100:runtime';
const temporaryRoots: string[] = [];

function root(): string {
  const value = realpathSync(mkdtempSync(join(
    realpathSync(tmpdir()),
    'agent-deck-server-core-runtime-',
  )));
  temporaryRoots.push(value);
  return value;
}

function paths(base: string): DaemonInstancePaths {
  return {
    instanceId: INSTANCE_ID,
    stateDirectory: join(base, 'state'),
    configurationDirectory: join(base, 'config'),
    logDirectory: join(base, 'state', 'logs'),
    runtimeDirectory: join(base, 'run'),
    socketPath: join(base, 'run', 'agent-deckd.sock'),
  };
}

function input(base: string, runtimeOptions: ServerCoreRuntimeFactoryInput['runtimeOptions'] = {}) {
  return {
    instanceId: INSTANCE_ID,
    appVersion: '1.0.0',
    paths: paths(base),
    runtimeOptions,
  } satisfies ServerCoreRuntimeFactoryInput;
}

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: INSTANCE_ID,
  clientId: 'desktop-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

afterEach(() => {
  for (const value of temporaryRoots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('concrete Server Core runtime composition', () => {
  it('starts real repositories and the isolated provider set without a desktop singleton', async () => {
    const base = root();
    const secretDirectory = join(base, 'secrets');
    const credentialFile = join(secretDirectory, 'credentials.json');
    mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(credentialFile, JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      credentials: [{
        credentialId: 'credential-a',
        surface: 'desktop-full',
        status: 'active',
      }],
    }), { mode: 0o600 });
    chmodSync(credentialFile, 0o600);
    const diagnostics = { info: vi.fn(), warn: vi.fn() };
    const bootstrap = createServerCoreRuntimeWithOverrides(input(base, {
      providerSettings: {
        claudeCliPath: '/usr/bin/true',
        codexCliPath: '/usr/bin/true',
        grokCliPath: '/usr/bin/true',
      },
      projects: [],
    }), {
      processId: PROCESS_ID,
      credentialFilePath: credentialFile,
      diagnostics,
    });

    expect(bootstrap.processId).toBe(PROCESS_ID);
    expect(bootstrap.components).toEqual([]);
    await bootstrap.runtime.start();
    expect(await bootstrap.runtime.currentRevision(access)).toBe(0);
    await expect(bootstrap.credentialLifecycle.isActive({
      identity: {
        instanceId: INSTANCE_ID,
        processId: PROCESS_ID,
        accessCredentialId: 'credential-a',
        accessSurface: 'desktop-full',
      },
      signal: new AbortController().signal,
    })).resolves.toBe(true);
    expect(await bootstrap.sessionConsoleAuthority.listSessions(
      { includeArchived: false, limit: 20 },
      {
        access,
        idempotencyKey: null,
        expectedRevision: null,
        deadlineAt: null,
        signal: new AbortController().signal,
      },
    )).toEqual({ sessions: [], nextCursor: null, total: 0, revision: 0 });

    await bootstrap.runtime.stop('test');
    expect(diagnostics.warn.mock.calls.flat().join(' ')).not.toContain(credentialFile);
  });

  it('rejects unknown runtime roots before constructing provider state', () => {
    const base = root();
    expect(() => createServerCoreRuntimeWithOverrides(input(base, {
      providerSettings: {},
      typoCredentialFile: '/tmp/unsafe',
    }), {
      processId: PROCESS_ID,
      credentialFilePath: join(base, 'credentials.json'),
      diagnostics: { info: vi.fn(), warn: vi.fn() },
    })).toThrow('runtimeOptions.typoCredentialFile is unsupported');
  });

  it('binds a Local Worker project catalog to its explicit workspace root', async () => {
    const base = root();
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const bootstrap = createServerCoreRuntimeWithOverrides(input(base, {
      providerSettings: {
        claudeCliPath: '/usr/bin/true',
        codexCliPath: '/usr/bin/true',
        grokCliPath: '/usr/bin/true',
      },
      projects: [{
        alias: 'workspace',
        projectId: 'worker-workspace',
        projectRef: 'workspace',
        title: null,
        workspacePath: workspace,
      }],
    }), {
      workspaceRoot: workspace,
    });

    await bootstrap.runtime.start();
    try {
      const projects = parseProjectListResult(bootstrap.sessionConsoleAuthority.listProjects(
        { limit: 20 },
        {
          access,
          idempotencyKey: null,
          expectedRevision: null,
          deadlineAt: null,
          signal: new AbortController().signal,
        },
      ), 20);
      expect(projects.projects).toEqual([{
        alias: 'workspace',
        projectId: 'worker-workspace',
        projectRef: 'workspace',
        title: null,
      }]);
    } finally {
      await bootstrap.runtime.stop('test');
    }
  });
});
