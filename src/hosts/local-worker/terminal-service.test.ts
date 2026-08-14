import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { configureLocalWorker } from './terminal-configuration';
import {
  LocalWorkerTerminalServiceManager,
  type LocalWorkerServiceCommandPort,
  type LocalWorkerServiceCommandResult,
} from './terminal-service';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeServiceCommands implements LocalWorkerServiceCommandPort {
  readonly calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  loaded = false;
  running = false;

  async run(executable: string, args: readonly string[]): Promise<LocalWorkerServiceCommandResult> {
    this.calls.push({ executable, args: [...args] });
    if (
      (executable === '/bin/launchctl' && args[0] === 'print') ||
      (executable === '/usr/bin/systemctl' && args.includes('is-active'))
    ) {
      if (executable === '/bin/launchctl') {
        return this.result(
          this.loaded ? 0 : 113,
          this.loaded ? `state = ${this.running ? 'running' : 'not running'}\n` : '',
        );
      }
      return this.result(this.running ? 0 : 3);
    }
    if (
      (executable === '/bin/launchctl' && ['bootstrap', 'kickstart'].includes(args[0])) ||
      (executable === '/usr/bin/systemctl' && args.includes('enable'))
    ) {
      this.loaded = true;
      this.running = true;
    }
    if (
      (executable === '/bin/launchctl' && args[0] === 'bootout') ||
      (executable === '/usr/bin/systemctl' && args.includes('disable'))
    ) {
      this.loaded = false;
      this.running = false;
    }
    return this.result(0);
  }

  private result(exitCode: number, stdout = ''): LocalWorkerServiceCommandResult {
    return { exitCode, stdout, stderr: '', timedOut: false };
  }
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-service-')));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const serviceRoot = join(root, 'services');
  const workspaceRoot = join(root, 'workspace');
  const runtimeRoot = join(root, 'runtime');
  const providerRuntimeRoot = join(root, 'provider-runtime');
  const wrapperPath = join(root, 'agent-deck-worker');
  const sandboxLauncherPath = join(root, 'agent-deck-worker-sandbox');
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(serviceRoot, { mode: 0o700 });
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o755 });
  writeFileSync(wrapperPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(sandboxLauncherPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  chmodSync(sandboxLauncherPath, 0o755);
  const runtimeModule = join(runtimeRoot, 'index.mjs');
  writeFileSync(runtimeModule, 'export {};\n', { mode: 0o644 });
  const credentialFile = join(root, 'worker.agentdeck-connection');
  writeFileSync(credentialFile, `${JSON.stringify({
    schemaVersion: 3,
    kind: 'agent-deck-remote-connection-credential',
    label: 'Production Relay',
    purpose: 'worker',
    topology: 'relay',
    instanceId: 'instance-a',
    credentialId: 'worker-credential-a',
    workerId: 'worker-a',
    endpoint: { hostname: 'relay.example.test', port: 22, username: 'agentdeck' },
    hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: HOST_KEY }],
    identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
  })}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  return {
    credentialFile,
    providerRuntimeRoot,
    runtimeModule,
    runtimeRoot,
    serviceRoot,
    sandboxLauncherPath,
    stateRoot,
    workspaceRoot,
    wrapperPath,
  };
}

async function installed(
  paths: ReturnType<typeof fixture>,
  platform: 'darwin' | 'linux' = 'linux',
) {
  return configureLocalWorker({
    appVersion: '0.1.0',
    credentialFile: paths.credentialFile,
    runtimeModule: paths.runtimeModule,
    runtimeReadRoots: [paths.runtimeRoot],
    sshBinary: '/usr/bin/ssh',
    stateRoot: paths.stateRoot,
    workspaceRoot: paths.workspaceRoot,
    platform,
    ...(platform === 'darwin' ? {
      workspaceBookmark: {
        create: async (_workspaceRoot: string, bookmarkFile: string) => {
          writeFileSync(bookmarkFile, 'bounded-bookmark\n', { mode: 0o600 });
          chmodSync(bookmarkFile, 0o600);
        },
      },
    } : {}),
  });
}

describe('terminal-only Local Worker service lifecycle', () => {
  it('installs, persists, stops, restarts, and removes one macOS LaunchAgent', async () => {
    const paths = fixture();
    const worker = await installed(paths, 'darwin');
    const commands = new FakeServiceCommands();
    const manager = new LocalWorkerTerminalServiceManager({
      platform: 'darwin',
      serviceRoot: paths.serviceRoot,
      stateRoot: paths.stateRoot,
      wrapperPath: paths.wrapperPath,
      uid: CURRENT_UID,
      commands,
      providerRuntimeRoot: () => paths.providerRuntimeRoot,
      darwinSandboxLauncherPath: paths.sandboxLauncherPath,
    });

    await expect(manager.status()).resolves.toEqual({
      state: 'stopped', workerConfigId: worker.workerConfigId,
    });
    await expect(manager.start()).resolves.toEqual({
      state: 'running', workerConfigId: worker.workerConfigId,
    });
    const plist = join(paths.serviceRoot, `com.agentdeck.worker.${worker.workerConfigId}.plist`);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(readFileSync(plist, 'utf8')).toContain('<key>KeepAlive</key><true/>');
    expect(readFileSync(plist, 'utf8')).not.toContain('SuccessfulExit');
    expect(readFileSync(plist, 'utf8')).toContain(paths.workspaceRoot);
    expect(readFileSync(plist, 'utf8')).toContain(`<string>${paths.sandboxLauncherPath}</string>`);
    expect(readFileSync(plist, 'utf8')).toContain(join(worker.privateRoot, 'workspace.bookmark'));
    expect(readFileSync(plist, 'utf8')).not.toContain('workspace.sb');
    expect(readFileSync(plist, 'utf8')).not.toContain('/usr/bin/sandbox-exec');
    expect(readFileSync(plist, 'utf8')).toContain(worker.config.workspaceSandbox!.environment.providerHomeRoot);
    await expect(manager.status()).resolves.toMatchObject({ state: 'running' });
    commands.running = false;
    await expect(manager.status()).resolves.toMatchObject({ state: 'stopped' });
    commands.running = true;
    await expect(manager.stop()).resolves.toMatchObject({ state: 'stopped' });
    await expect(manager.start()).resolves.toMatchObject({ state: 'running' });
    expect(commands.calls.some(({ executable, args }) =>
      executable === '/bin/launchctl' && args[0] === 'bootstrap')).toBe(true);

    await expect(manager.remove()).resolves.toEqual({
      state: 'not-configured', workerConfigId: null,
    });
    expect(existsSync(worker.privateRoot)).toBe(false);
    expect(existsSync(plist)).toBe(false);
  });

  it('writes and controls one hardened Linux systemd-user unit', async () => {
    const paths = fixture();
    const worker = await installed(paths);
    const commands = new FakeServiceCommands();
    const manager = new LocalWorkerTerminalServiceManager({
      platform: 'linux',
      serviceRoot: paths.serviceRoot,
      stateRoot: paths.stateRoot,
      wrapperPath: paths.wrapperPath,
      uid: CURRENT_UID,
      commands,
      providerRuntimeRoot: () => paths.providerRuntimeRoot,
    });

    await manager.start(worker.workerConfigId);
    const unit = join(paths.serviceRoot, `agent-deck-worker-${worker.workerConfigId}.service`);
    const source = readFileSync(unit, 'utf8');
    expect(source).toContain('Restart=on-failure');
    expect(source).toContain('NoNewPrivileges=true');
    expect(source).toContain('ExecStart="/usr/bin/bwrap"');
    expect(source).toContain(
      `ExecStartPre="${paths.wrapperPath}" prepare-provider-runtime --root "${paths.providerRuntimeRoot}"`,
    );
    expect(source).toContain('"--unshare-all"');
    expect(source).toContain('"--clearenv"');
    expect(source).toContain(`ReadWritePaths="${paths.workspaceRoot}" "${worker.privateRoot}"`);
    expect(source).toContain(paths.providerRuntimeRoot);
    expect(source).toContain(`"${dirname(paths.providerRuntimeRoot)}"`);
    expect(commands.calls).toContainEqual({
      executable: '/usr/bin/systemctl',
      args: ['--user', 'daemon-reload'],
    });
    expect(commands.calls.some(({ args }) => args.includes('enable'))).toBe(true);
    await expect(manager.status()).resolves.toMatchObject({ state: 'running' });
    await expect(manager.stop()).resolves.toMatchObject({ state: 'stopped' });
  });

  it('refreshes provider choices from the terminal Home before every Worker start', async () => {
    const paths = fixture();
    const sourceHome = join(paths.workspaceRoot, '..', 'provider-source');
    mkdirSync(join(sourceHome, '.codex'), { recursive: true, mode: 0o700 });
    const configPath = join(sourceHome, '.codex', 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-first"',
      'model_provider = "team"',
      '[model_providers.team]',
      'name = "Team"',
    ].join('\n'), { mode: 0o600 });
    const worker = await installed(paths);
    const manager = new LocalWorkerTerminalServiceManager({
      platform: 'linux',
      serviceRoot: paths.serviceRoot,
      stateRoot: paths.stateRoot,
      wrapperPath: paths.wrapperPath,
      uid: CURRENT_UID,
      commands: new FakeServiceCommands(),
      providerRuntimeRoot: () => paths.providerRuntimeRoot,
      providerSourceHome: realpathSync(sourceHome),
    });

    await manager.start(worker.workerConfigId);
    const providerHome = worker.config.workspaceSandbox!.environment.providerHomeRoot;
    expect(readFileSync(join(providerHome, '.codex', 'config.toml'), 'utf8'))
      .toContain('gpt-first');

    writeFileSync(configPath, [
      'model = "gpt-second"',
      'model_provider = "team"',
      '[model_providers.team]',
      'name = "Team"',
    ].join('\n'), { mode: 0o600 });
    await manager.start(worker.workerConfigId);
    expect(readFileSync(join(providerHome, '.codex', 'config.toml'), 'utf8'))
      .toContain('gpt-second');
    expect(readFileSync(
      join(providerHome, '.agent-deck', 'session-create-catalog.json'),
      'utf8',
    )).toContain('gpt-second');
  });

  it('projects one validated Grok credential into the selected Worker private root', async () => {
    const paths = fixture();
    const worker = await installed(paths, 'darwin');
    const credentialFile = join(dirname(paths.stateRoot), 'grok-auth.json');
    writeFileSync(credentialFile, `${JSON.stringify({
      'xai::cached': {
        auth_mode: 'oauth',
        key: 'fixture-provider-token',
        expires_at: '2999-01-01T00:00:00.000Z',
      },
    })}\n`, { mode: 0o600 });
    chmodSync(credentialFile, 0o600);
    const manager = new LocalWorkerTerminalServiceManager({
      platform: 'darwin',
      serviceRoot: paths.serviceRoot,
      stateRoot: paths.stateRoot,
      wrapperPath: paths.wrapperPath,
      uid: CURRENT_UID,
      commands: new FakeServiceCommands(),
      providerRuntimeRoot: () => paths.providerRuntimeRoot,
      darwinSandboxLauncherPath: paths.sandboxLauncherPath,
    });

    await expect(manager.installProviderCredential(
      credentialFile,
      worker.workerConfigId,
    )).resolves.toEqual({ state: 'stopped', workerConfigId: worker.workerConfigId });

    const target = join(worker.privateRoot, 'provider-inference', 'grok-auth.json');
    expect(statSync(dirname(target)).mode & 0o777).toBe(0o700);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).not.toContain('unexpected');
  });

  it('reports an unconfigured state without inventing a Worker', async () => {
    const paths = fixture();
    const manager = new LocalWorkerTerminalServiceManager({
      platform: 'darwin',
      serviceRoot: paths.serviceRoot,
      stateRoot: paths.stateRoot,
      wrapperPath: paths.wrapperPath,
      uid: CURRENT_UID,
      commands: new FakeServiceCommands(),
      providerRuntimeRoot: () => paths.providerRuntimeRoot,
      darwinSandboxLauncherPath: paths.sandboxLauncherPath,
    });

    await expect(manager.status()).resolves.toEqual({
      state: 'not-configured', workerConfigId: null,
    });
    await expect(manager.start()).rejects.toThrow('尚未配置');
  });
});
