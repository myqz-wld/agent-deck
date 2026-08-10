import { execFile } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  assertWorkspaceSandboxIdentity,
  buildDarwinWorkspaceSandboxLaunch,
  buildLinuxWorkspaceSandboxLaunch,
  captureWorkspaceSandboxIdentity,
  type WorkspaceSandboxLaunchCommand,
} from '@hosts/workspace-sandbox';

import { parseLocalWorkerHeadlessConfig, type LocalWorkerHeadlessConfig } from './headless-config';
import { DARWIN_WORKSPACE_BOOKMARK_FILE } from './terminal-configuration';
import { prepareProviderSessionRuntimeDirectories } from '@hosts/provider-session/runtime-directories';
import { providerSessionWorkerRuntimeRoot } from '@hosts/provider-session/runtime-paths';

const WORKER_CONFIG_ID = /^worker-[a-f0-9]{24}$/;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export type LocalWorkerServiceState = 'not-configured' | 'running' | 'stopped';

export interface LocalWorkerServiceStatus {
  readonly state: LocalWorkerServiceState;
  readonly workerConfigId: string | null;
}

export interface LocalWorkerServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface LocalWorkerServiceCommandPort {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<LocalWorkerServiceCommandResult>;
}

export interface LocalWorkerServiceManagerOptions {
  readonly platform: 'darwin' | 'linux';
  readonly serviceRoot: string;
  readonly stateRoot: string;
  readonly wrapperPath: string;
  readonly darwinSandboxLauncherPath?: string;
  readonly uid?: number;
  readonly commands?: LocalWorkerServiceCommandPort;
  readonly providerRuntimeRoot?: (
    workerConfigId: string,
    platform: 'darwin' | 'linux',
    uid: number,
  ) => string;
}

interface InstalledWorker {
  readonly config: LocalWorkerHeadlessConfig;
  readonly configFile: string;
  readonly privateRoot: string;
  readonly workerConfigId: string;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
  };
  for (const key of ['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const) {
    const value = process.env[key];
    if (value) output[key] = value;
  }
  return output;
}

const PRODUCTION_COMMANDS: LocalWorkerServiceCommandPort = Object.freeze({
  run(executable, args, timeoutMs): Promise<LocalWorkerServiceCommandResult> {
    return new Promise<LocalWorkerServiceCommandResult>((resolveCommand) => {
      execFile(executable, [...args], {
        encoding: 'utf8',
        env: commandEnvironment(),
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        shell: false,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolveCommand(Object.freeze({
          exitCode: typeof code === 'number' ? code : error ? 1 : 0,
          stdout,
          stderr,
          timedOut: Boolean(error && 'killed' in error && error.killed),
        }));
      });
    });
  },
});

function assertOwnedDirectory(path: string, field: string, exactMode?: number): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical absolute directory`);
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const mode = stat.mode & 0o777;
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (uid !== null && stat.uid !== uid) ||
    (exactMode === undefined ? (mode & 0o022) !== 0 : mode !== exactMode)
  ) {
    throw new Error(`${field} ownership or mode is invalid`);
  }
}

function assertTrustedWrapper(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('Worker wrapper path is invalid');
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    (uid !== null && stat.uid !== uid && stat.uid !== 0)
  ) {
    throw new Error('Worker wrapper trust check failed');
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemd(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('systemd path contains control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function serviceLabel(workerConfigId: string): string {
  return `com.agentdeck.worker.${workerConfigId}`;
}

function serviceUnit(workerConfigId: string): string {
  return `agent-deck-worker-${workerConfigId}.service`;
}

function darwinEnvironment(launch: WorkspaceSandboxLaunchCommand): string {
  return Object.entries(launch.environment)
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('\n');
}

function darwinDefinition(worker: InstalledWorker, launch: WorkspaceSandboxLaunchCommand): string {
  const label = serviceLabel(worker.workerConfigId);
  const stdoutPath = join(worker.privateRoot, 'service.stdout.log');
  const stderrPath = join(worker.privateRoot, 'service.stderr.log');
  const programArguments = [launch.executable, ...launch.args]
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key><dict>
${darwinEnvironment(launch)}
  </dict>
  <key>WorkingDirectory</key><string>${xml(worker.config.workspaceSandbox!.workspaceRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict></plist>
`;
}

function linuxDefinition(
  worker: InstalledWorker,
  launch: WorkspaceSandboxLaunchCommand,
  providerRuntimeRoot: string,
  wrapperPath: string,
): string {
  const sandbox = worker.config.workspaceSandbox!;
  const command = [launch.executable, ...launch.args].map(systemd).join(' ');
  const providerRuntimeParent = dirname(providerRuntimeRoot);
  return `[Unit]
Description=Agent Deck Local Worker (${worker.workerConfigId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=${systemd(wrapperPath)} prepare-provider-runtime --root ${systemd(providerRuntimeRoot)}
ExecStart=${command}
WorkingDirectory=${systemd(sandbox.workspaceRoot)}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60s
KillMode=mixed
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${systemd(sandbox.workspaceRoot)} ${systemd(sandbox.privateRoot)} ${systemd(providerRuntimeParent)} ${systemd(`-${providerRuntimeRoot}`)}

[Install]
WantedBy=default.target
`;
}

async function writeDefinition(path: string, source: string): Promise<void> {
  const bytes = Buffer.from(source, 'utf8');
  try {
    await new AtomicPrivateStateFile(path, 128 * 1024).write(bytes);
  } finally {
    bytes.fill(0);
  }
}

function safeUnlink(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
    (uid !== null && stat.uid !== uid) || realpathSync(path) !== path
  ) {
    throw new Error('Worker service definition is unsafe');
  }
  unlinkSync(path);
}

export class LocalWorkerTerminalServiceManager {
  private readonly commands: LocalWorkerServiceCommandPort;
  private readonly uid: number;

  constructor(private readonly options: LocalWorkerServiceManagerOptions) {
    this.commands = options.commands ?? PRODUCTION_COMMANDS;
    this.uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
    if (!Number.isSafeInteger(this.uid) || this.uid < 0) {
      throw new Error('Worker service requires one concrete uid');
    }
    assertOwnedDirectory(options.stateRoot, 'Worker state root', 0o700);
    mkdirSync(options.serviceRoot, { mode: 0o700, recursive: true });
    assertOwnedDirectory(options.serviceRoot, 'Worker service root');
    assertTrustedWrapper(options.wrapperPath);
    if (options.platform === 'darwin') {
      if (!options.darwinSandboxLauncherPath) {
        throw new Error('macOS Worker 缺少签名沙盒启动程序');
      }
      assertTrustedWrapper(options.darwinSandboxLauncherPath);
    }
  }

  private async find(workerConfigId?: string): Promise<InstalledWorker | null> {
    if (workerConfigId !== undefined && !WORKER_CONFIG_ID.test(workerConfigId)) {
      throw new Error('Worker 配置标识无效');
    }
    const candidates = readdirSync(this.options.stateRoot, { withFileTypes: true })
      .filter((entry) => WORKER_CONFIG_ID.test(entry.name))
      .map((entry) => entry.name)
      .filter((name) => workerConfigId === undefined || name === workerConfigId)
      .sort();
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new Error('检测到多个 Worker 配置；请使用 --worker 指定一个配置');
    }
    const id = candidates[0];
    const privateRoot = join(this.options.stateRoot, id);
    assertOwnedDirectory(privateRoot, 'Worker private root', 0o700);
    const configFile = join(privateRoot, 'worker.json');
    const config = parseLocalWorkerHeadlessConfig(await readPrivateJsonFile(configFile));
    if (
      !config.workspaceSandbox ||
      config.workspaceSandbox.workerConfigId !== id ||
      config.workspaceSandbox.privateRoot !== privateRoot
    ) {
      throw new Error('Worker 配置与私有目录不匹配');
    }
    return Object.freeze({ config, configFile, privateRoot, workerConfigId: id });
  }

  private definitionPath(worker: InstalledWorker): string {
    return this.options.platform === 'darwin'
      ? join(this.options.serviceRoot, `${serviceLabel(worker.workerConfigId)}.plist`)
      : join(this.options.serviceRoot, serviceUnit(worker.workerConfigId));
  }

  private bookmarkPath(worker: InstalledWorker): string {
    return join(worker.privateRoot, DARWIN_WORKSPACE_BOOKMARK_FILE);
  }

  private async required(workerConfigId?: string): Promise<InstalledWorker> {
    const worker = await this.find(workerConfigId);
    if (!worker) throw new Error('Worker 尚未配置');
    return worker;
  }

  private async run(executable: string, args: readonly string[]): Promise<LocalWorkerServiceCommandResult> {
    const result = await this.commands.run(executable, args, COMMAND_TIMEOUT_MS);
    if (result.timedOut || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_COMMAND_OUTPUT_BYTES) {
      throw new Error('Worker 服务管理命令超出边界');
    }
    return result;
  }

  async start(workerConfigId?: string): Promise<LocalWorkerServiceStatus> {
    const worker = await this.required(workerConfigId);
    const sandbox = worker.config.workspaceSandbox!;
    const providerRuntimeRoot = this.options.providerRuntimeRoot?.(
      worker.workerConfigId,
      this.options.platform,
      this.uid,
    ) ?? providerSessionWorkerRuntimeRoot({
      platform: this.options.platform,
      uid: this.uid,
      workerConfigId: worker.workerConfigId,
    });
    prepareProviderSessionRuntimeDirectories([providerRuntimeRoot], this.uid);
    const sandboxIdentity = captureWorkspaceSandboxIdentity(sandbox, this.uid);
    const definitionPath = this.definitionPath(worker);
    const launch = this.options.platform === 'darwin'
      ? buildDarwinWorkspaceSandboxLaunch(sandbox, {
        bookmarkPath: this.bookmarkPath(worker),
        configFile: worker.configFile,
        launcherPath: this.options.darwinSandboxLauncherPath!,
        wrapperPath: this.options.wrapperPath,
      })
      : buildLinuxWorkspaceSandboxLaunch(sandbox, {
        configFile: worker.configFile,
        providerRuntimeRoot,
        wrapperPath: this.options.wrapperPath,
      });
    const definition = this.options.platform === 'darwin'
      ? darwinDefinition(worker, launch)
      : linuxDefinition(worker, launch, providerRuntimeRoot, this.options.wrapperPath);
    await writeDefinition(definitionPath, definition);
    assertWorkspaceSandboxIdentity(sandboxIdentity);
    assertOwnedDirectory(providerRuntimeRoot, 'Provider runtime root', 0o700);
    if (this.options.platform === 'darwin') {
      const target = `gui/${this.uid}/${serviceLabel(worker.workerConfigId)}`;
      const current = await this.run('/bin/launchctl', ['print', target]);
      const started = current.exitCode === 0
        ? await this.run('/bin/launchctl', ['kickstart', '-k', target])
        : await this.run('/bin/launchctl', ['bootstrap', `gui/${this.uid}`, definitionPath]);
      if (started.exitCode !== 0) throw new Error('Worker launchd 服务启动失败');
    } else {
      const reload = await this.run('/usr/bin/systemctl', ['--user', 'daemon-reload']);
      const started = await this.run('/usr/bin/systemctl', [
        '--user', 'enable', '--now', '--', serviceUnit(worker.workerConfigId),
      ]);
      if (reload.exitCode !== 0 || started.exitCode !== 0) {
        throw new Error('Worker systemd-user 服务启动失败');
      }
    }
    return Object.freeze({ state: 'running', workerConfigId: worker.workerConfigId });
  }

  async status(workerConfigId?: string): Promise<LocalWorkerServiceStatus> {
    const worker = await this.find(workerConfigId);
    if (!worker) return Object.freeze({ state: 'not-configured', workerConfigId: null });
    const result = this.options.platform === 'darwin'
      ? await this.run('/bin/launchctl', [
        'print', `gui/${this.uid}/${serviceLabel(worker.workerConfigId)}`,
      ])
      : await this.run('/usr/bin/systemctl', [
        '--user', 'is-active', '--quiet', '--', serviceUnit(worker.workerConfigId),
      ]);
    if (result.exitCode !== 0 && ![3, 4, 113].includes(result.exitCode)) {
      throw new Error('Worker 服务状态读取失败');
    }
    const running = this.options.platform === 'darwin'
      ? result.exitCode === 0 && /^\s*state = running\s*$/m.test(result.stdout)
      : result.exitCode === 0;
    return Object.freeze({
      state: running ? 'running' : 'stopped',
      workerConfigId: worker.workerConfigId,
    });
  }

  async stop(workerConfigId?: string): Promise<LocalWorkerServiceStatus> {
    const worker = await this.required(workerConfigId);
    const result = this.options.platform === 'darwin'
      ? await this.run('/bin/launchctl', [
        'bootout', `gui/${this.uid}/${serviceLabel(worker.workerConfigId)}`,
      ])
      : await this.run('/usr/bin/systemctl', [
        '--user', 'disable', '--now', '--', serviceUnit(worker.workerConfigId),
      ]);
    if (result.exitCode !== 0 && ![3, 4, 5, 113].includes(result.exitCode)) {
      throw new Error('Worker 服务停止失败');
    }
    return Object.freeze({ state: 'stopped', workerConfigId: worker.workerConfigId });
  }

  async remove(workerConfigId?: string): Promise<LocalWorkerServiceStatus> {
    const worker = await this.required(workerConfigId);
    await this.stop(worker.workerConfigId);
    safeUnlink(this.definitionPath(worker));
    if (this.options.platform === 'linux') {
      const reload = await this.run('/usr/bin/systemctl', ['--user', 'daemon-reload']);
      if (reload.exitCode !== 0) throw new Error('Worker systemd-user 配置刷新失败');
    }
    assertOwnedDirectory(worker.privateRoot, 'Worker private root', 0o700);
    if (dirname(worker.privateRoot) !== this.options.stateRoot || basename(worker.privateRoot) !== worker.workerConfigId) {
      throw new Error('Worker 删除目标越过私有目录边界');
    }
    rmSync(worker.privateRoot, { recursive: true, force: false });
    return Object.freeze({ state: 'not-configured', workerConfigId: null });
  }
}
