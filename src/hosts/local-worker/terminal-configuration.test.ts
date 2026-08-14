import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { configureLocalWorker } from './terminal-configuration';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(purpose: 'client' | 'worker' = 'worker') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-configure-')));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const workspaceRoot = join(root, 'workspace');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o755 });
  const runtimeModule = join(runtimeRoot, 'index.mjs');
  writeFileSync(runtimeModule, 'export {};\n', { mode: 0o644 });
  const credentialFile = join(root, `${purpose}.agentdeck-connection`);
  writeFileSync(credentialFile, `${JSON.stringify({
    schemaVersion: 3,
    kind: 'agent-deck-remote-connection-credential',
    label: 'Production Relay',
    purpose,
    topology: 'relay',
    instanceId: 'instance-a',
    credentialId: `${purpose}-credential-a`,
    ...(purpose === 'client' ? { connectionScope: `scope-${purpose}-credential-a` } : {}),
    ...(purpose === 'worker' ? { workerId: 'worker-a' } : {}),
    endpoint: { hostname: 'relay.example.test', port: 22, username: 'agentdeck' },
    hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: HOST_KEY }],
    identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
  })}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  return { root, stateRoot, workspaceRoot, runtimeRoot, runtimeModule, credentialFile };
}

function input(paths: ReturnType<typeof fixture>) {
  return {
    appVersion: '0.1.0',
    credentialFile: paths.credentialFile,
    runtimeModule: paths.runtimeModule,
    runtimeReadRoots: [paths.runtimeRoot],
    sshBinary: '/usr/bin/ssh',
    stateRoot: paths.stateRoot,
    workspaceRoot: paths.workspaceRoot,
    platform: 'linux' as const,
  };
}

describe('terminal-only Local Worker configuration', () => {
  it('installs one purpose-locked Worker into an app-private tree', async () => {
    const paths = fixture();
    const installed = await configureLocalWorker(input(paths));

    expect(installed.workerConfigId).toMatch(/^worker-[a-f0-9]{24}$/);
    expect(installed.config.workspaceSandbox).toMatchObject({
      workerConfigId: installed.workerConfigId,
      workspaceRoot: paths.workspaceRoot,
    });
    expect(installed.config.runtimeOptions).toEqual({});
    expect(statSync(installed.privateRoot).mode & 0o777).toBe(0o700);
    expect(statSync(installed.config.ssh.identityFile).mode & 0o777).toBe(0o600);
    expect(statSync(installed.config.ssh.knownHostsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(installed.config.ssh.identityFile, 'utf8')).toContain('OPENSSH PRIVATE KEY');
    expect(readFileSync(installed.configFile, 'utf8')).not.toContain('OPENSSH PRIVATE KEY');
    expect(readFileSync(installed.config.ssh.knownHostsFile, 'utf8'))
      .toContain('relay.example.test ssh-ed25519');
  });

  it('rejects a Client credential without creating Worker state', async () => {
    const paths = fixture('client');

    await expect(configureLocalWorker(input(paths))).rejects.toThrow('Client 凭证');
    expect(readFileSync(paths.credentialFile, 'utf8')).toContain('"purpose":"client"');
    expect(statSync(paths.stateRoot).mode & 0o777).toBe(0o700);
  });

  it('requires mode 0600 and never silently replaces an existing Worker config', async () => {
    const paths = fixture();
    chmodSync(paths.credentialFile, 0o644);
    await expect(configureLocalWorker(input(paths))).rejects.toThrow('mode 0600');
    chmodSync(paths.credentialFile, 0o600);
    await configureLocalWorker(input(paths));
    await expect(configureLocalWorker(input(paths))).rejects.toThrow('已存在');
  });

  it('creates a private macOS workspace bookmark before publishing config', async () => {
    const paths = fixture();
    const calls: string[][] = [];
    const installed = await configureLocalWorker({
      ...input(paths),
      platform: 'darwin',
      workspaceBookmark: {
        create: async (workspaceRoot, bookmarkFile) => {
          calls.push([workspaceRoot, bookmarkFile]);
          writeFileSync(bookmarkFile, 'bounded-bookmark\n', { mode: 0o600 });
          chmodSync(bookmarkFile, 0o600);
        },
      },
    });

    expect(calls).toEqual([[
      paths.workspaceRoot,
      join(installed.privateRoot, 'workspace.bookmark'),
    ]]);
    expect(statSync(join(installed.privateRoot, 'workspace.bookmark')).mode & 0o777).toBe(0o600);
  });
});
