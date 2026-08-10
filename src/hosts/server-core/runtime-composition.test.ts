import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  it('owns an injected Provider Grok container runtime through provider shutdown', async () => {
    const base = root();
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const close = vi.fn(async () => undefined);
    const bootstrap = createServerCoreRuntimeWithOverrides(input(base), {
      workspaceRoot: workspace,
      grokContainer: {
        close,
        processFactory: vi.fn(async () => {
          throw new Error('unused process factory');
        }),
        readiness: vi.fn(async () => ({
          available: false,
          disabledReason: 'provider-session-supervisor-unavailable' as const,
          supervisorGeneration: 0,
        })),
      },
    });

    await bootstrap.runtime.start();
    await bootstrap.runtime.stop('test');
    expect(close).toHaveBeenCalledOnce();
  });

  it('starts real repositories and the isolated provider set without a desktop singleton', async () => {
    const base = root();
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
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
      workspaceRoot: workspace,
    });

    expect(bootstrap.processId).toBe(PROCESS_ID);
    expect(bootstrap.components).toEqual([]);
    expect(bootstrap.runtime.supportedMethods).toEqual(expect.arrayContaining([
      'teams.list',
      'teams.get',
      'usage.tokens.get',
      'usage.providers.get',
    ]));
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

  it('projects only fixed provider auth files from the Full secrets volume seam', async () => {
    const base = root();
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const providerAuthSource = join(base, 'provider-auth');
    mkdirSync(join(providerAuthSource, '.codex'), { recursive: true, mode: 0o700 });
    mkdirSync(join(providerAuthSource, '.grok'), { recursive: true, mode: 0o700 });
    mkdirSync(join(providerAuthSource, '.ssh'), { recursive: true, mode: 0o700 });
    writeFileSync(join(providerAuthSource, '.codex', 'auth.json'), '{"token":"test"}\n', {
      mode: 0o600,
    });
    writeFileSync(join(providerAuthSource, '.codex', 'config.toml'), 'model="unsafe"\n', {
      mode: 0o600,
    });
    writeFileSync(join(providerAuthSource, '.grok', 'auth.json'),
      '{"scope":{"key":"private"}}\n', { mode: 0o600 });
    writeFileSync(join(providerAuthSource, '.grok', 'config.toml'), 'api_key="unsafe"\n', {
      mode: 0o600,
    });
    writeFileSync(join(providerAuthSource, '.ssh', 'id_ed25519'), 'never\n', { mode: 0o600 });
    const bootstrap = createServerCoreRuntimeWithOverrides(input(base), {
      providerAuthSource,
      workspaceRoot: workspace,
    });

    await bootstrap.runtime.start();
    try {
      const providerHome = join(base, 'state', 'provider-home');
      expect(readFileSync(join(providerHome, '.codex', 'auth.json'), 'utf8'))
        .toBe('{"token":"test"}\n');
      expect(() => readFileSync(join(providerHome, '.grok', 'auth.json'))).toThrow();
      expect(() => readFileSync(join(providerHome, '.grok', 'sandbox.toml'))).toThrow();
      expect(() => readFileSync(join(providerHome, '.codex', 'config.toml'))).toThrow();
      expect(() => readFileSync(join(providerHome, '.grok', 'config.toml'))).toThrow();
      expect(() => readFileSync(join(providerHome, '.ssh', 'id_ed25519'))).toThrow();
    } finally {
      await bootstrap.runtime.stop('test');
    }
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
