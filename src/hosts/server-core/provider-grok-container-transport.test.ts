import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ServerCoreProviderGrokContainerOpenInput,
  ServerCoreProviderGrokContainerSession,
} from './provider-grok-container-runtime';
import { createServerCoreProviderGrokContainerTransport } from './provider-grok-container-transport';

const fixture = fileURLToPath(new URL(
  '../../main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs',
  import.meta.url,
));
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function channel(
  input: ServerCoreProviderGrokContainerOpenInput,
): Promise<ServerCoreProviderGrokContainerSession> {
  const child = spawn(process.execPath, [fixture], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let closePromise: Promise<void> | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    exited,
    processId: `process-${input.sessionId}`,
    sessionId: input.sessionId,
    stream: Duplex.from({ readable: child.stdout, writable: child.stdin }),
    close: () => {
      closePromise ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
      })();
      return closePromise;
    },
  };
}

function clientInput(
  applicationSessionId: string,
  cwd: string,
  sandboxProfile: string | null,
) {
  return {
    applicationSessionId,
    cwd,
    sandboxProfile,
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(async () => ({
      outcome: { outcome: 'cancelled' as const },
    })),
  };
}

describe('Server Core Provider Grok container ACP transport', () => {
  it('maps exact sandbox ceilings and canonical Workspace cwd into the container namespace', async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-grok-ws-')));
    roots.push(workspaceRoot);
    const cwd = join(workspaceRoot, 'repo');
    mkdirSync(cwd);
    const opens: ServerCoreProviderGrokContainerOpenInput[] = [];
    const factory = createServerCoreProviderGrokContainerTransport({
      runtime: {
        open: async (input) => {
          opens.push(input);
          return channel(input);
        },
      },
      workspaceRoot,
    });
    const expected = [
      ['strict', 'provider-strict', '/workspace'],
      ['read-only', 'workspace-read-only', '/workspace/repo'],
      ['workspace', 'selected-directory-read-write', '/workspace/repo'],
      ['off', 'workspace-read-write', '/workspace/repo'],
    ] as const;
    for (const [profile, effectiveAccess, sessionCwd] of expected) {
      const launched = await factory(clientInput(`session-${profile}`, cwd, profile));
      expect(launched).toMatchObject({
        allowAgentDeckMcp: false,
        allowHostPathMetadata: false,
        sessionCwd,
      });
      expect(launched.process.pid).toBeNull();
      await launched.process.stop();
      expect(opens.at(-1)).toEqual({
        effectiveAccess,
        sessionId: `session-${profile}`,
        workingDirectory: 'repo',
      });
    }
    expect(JSON.stringify(opens)).not.toContain(workspaceRoot);
  });

  it('rejects an unsupported profile or cwd outside the captured Workspace before open', async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-grok-ws-')));
    const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-grok-out-')));
    roots.push(workspaceRoot, outside);
    const open = vi.fn(async (input: ServerCoreProviderGrokContainerOpenInput) => channel(input));
    const factory = createServerCoreProviderGrokContainerTransport({
      runtime: { open },
      workspaceRoot,
    });

    await expect(factory(clientInput('session-a', workspaceRoot, null)))
      .rejects.toThrow('sandbox profile');
    await expect(factory(clientInput('session-b', outside, 'workspace')))
      .rejects.toThrow('escapes the Workspace');
    expect(open).not.toHaveBeenCalled();
  });

  it('forwards the optional browser-only context without adding a host path', async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-grok-ws-')));
    roots.push(workspaceRoot);
    const open = vi.fn(async (input: ServerCoreProviderGrokContainerOpenInput) => channel(input));
    const factory = createServerCoreProviderGrokContainerTransport({
      runtime: { open }, workspaceRoot,
    });
    const browserContext = {
      protocolVersion: 1 as const,
      adapterId: 'grok-build' as const,
      lease: 'abcdefghijklmnopqrstuvwxyz012345',
      runtimeGeneration: 1,
      sourceIdentity: 'runtime-source-a',
    };

    const launched = await factory({
      ...clientInput('session-browser', workspaceRoot, 'workspace'),
      browserContext,
    });

    expect(open).toHaveBeenCalledWith({
      effectiveAccess: 'selected-directory-read-write',
      sessionId: 'session-browser',
      workingDirectory: '.',
      browserContext,
    });
    await launched.process.stop();
  });
});
