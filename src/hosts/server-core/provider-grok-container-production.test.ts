import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnixSocketDaemonListener } from '@hosts/daemon';
import {
  ProviderSessionSupervisorTransportServer,
  type ProviderSessionSupervisorControlPort,
} from '@hosts/provider-session';

import { createProductionServerCoreProviderGrokContainer } from './provider-grok-container-production';

const fixture = fileURLToPath(new URL(
  '../../main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs',
  import.meta.url,
));
const roots: string[] = [];
const servers: ProviderSessionSupervisorTransportServer[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function acpChannel() {
  const child = spawn(process.execPath, [fixture], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let closePromise: Promise<void> | null = null;
  return {
    exited,
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

describe('production Server Core Provider Grok container composition', () => {
  it('joins the private host transport, trusted broker, and ACP channel without topology leakage', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'agp-')));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const cwd = join(workspaceRoot, 'repo');
    const brokerRoot = join(root, 'broker');
    const credentialRoot = join(root, 'credentials');
    const supervisorRoot = join(root, 'supervisor');
    for (const path of [workspaceRoot, cwd, brokerRoot, credentialRoot, supervisorRoot]) {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    writeFileSync(join(credentialRoot, 'grok-auth.json'), JSON.stringify({
      'xai::cached': {
        auth_mode: 'oauth',
        expires_at: '2099-01-01T00:00:00Z',
        key: 'REAL_TRUSTED_TOKEN',
      },
    }), { mode: 0o600 });
    const launch = vi.fn<ProviderSessionSupervisorControlPort['launch']>(async (spec) => ({
      schemaVersion: 2,
      launchId: spec.launchId,
      processId: spec.processId,
      runtimeHandle: 'a'.repeat(64),
      sessionId: spec.sessionId,
    }));
    const supervisor: ProviderSessionSupervisorControlPort = {
      capabilities: async () => ({
        schemaVersion: 2,
        adapterIds: ['grok-build'],
        available: true,
        disabledReason: null,
        generation: 3,
      }),
      launch,
      attach: vi.fn(async () => acpChannel()),
      stop: vi.fn(async (spec) => ({ ...spec, stopped: true })),
      close: vi.fn(async () => undefined),
    };
    const socketPath = join(supervisorRoot, 's.sock');
    const server = new ProviderSessionSupervisorTransportServer({
      listener: new UnixSocketDaemonListener(socketPath, supervisorRoot),
      supervisor,
    });
    await server.start();
    servers.push(server);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const composition = createProductionServerCoreProviderGrokContainer({
      brokerRoot,
      credentialAllowedUids: [uid],
      credentialRoot,
      currentUid: () => uid,
      fetch: vi.fn(async () => new Response('{"choices":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      inferenceTransport: 'unix-http-v1',
      instanceId: 'instance-a',
      projectTrusted: async () => true,
      supervisorSocketPath: socketPath,
      workspaceRoot,
    });

    await expect(composition.readiness()).resolves.toEqual({
      available: true,
      disabledReason: null,
      supervisorGeneration: 3,
    });
    const launched = await composition.processFactory({
      applicationSessionId: 'session-a',
      cwd,
      sandboxProfile: 'workspace',
      onSessionUpdate: () => undefined,
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    expect(launched).toMatchObject({
      allowAgentDeckMcp: false,
      allowHostPathMetadata: false,
      sessionCwd: '/workspace/repo',
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({
      adapterId: 'grok-build',
      effectiveAccess: 'selected-directory-read-write',
      providerId: 'xai',
      sessionId: 'session-a',
      upstreamId: 'grok-xai',
      workingDirectory: 'repo',
    });
    expect(JSON.stringify(launch.mock.calls)).not.toMatch(
      /REAL_TRUSTED_TOKEN|credentialRoot|workspaceRoot|supervisorSocketPath|engine/i,
    );
    await launched.process.stop();
    await composition.close();
    expect(supervisor.stop).toHaveBeenCalledOnce();
    expect(supervisor.close).toHaveBeenCalledOnce();
  });
});
