import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isJsonObject, type JsonObject } from '@contracts/index';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  requireModuleFactory,
} from '@hosts/linux-runtime/runtime-module';
import { runCompositionService } from '@hosts/linux-runtime/service-runner';
import { parseExactFlags, requireAbsolutePath } from '@hosts/linux-runtime/validation';
import { preflightNodeNativeSqlite } from '@hosts/daemon/sqlite-preflight';
import { workspaceSandboxEnvironment } from '@hosts/workspace-sandbox';
import { prepareProviderSessionRuntimeDirectories } from '@hosts/provider-session/runtime-directories';

import { parseLocalWorkerHeadlessConfig } from './headless-config';
import { loadTrustedLocalWorkerRuntimeModule } from './darwin-runtime-module';
import { createLocalWorkerController } from './headless-root';
import {
  configureLocalWorker,
  createDarwinWorkspaceBookmarkPort,
} from './terminal-configuration';
import { LocalWorkerTerminalServiceManager } from './terminal-service';
import { readLocalWorkerGrokCredential } from './provider-credential';

function runtimeReadRoots(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 ||
      parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('runtime-read-roots must be a non-empty bounded JSON array');
  }
  return parsed.map((path, index) => requireAbsolutePath(path, `runtime-read-roots[${index}]`));
}

async function sessionCreationCatalog(path: string): Promise<JsonObject> {
  const value = await readPrivateJsonFile(
    requireAbsolutePath(path, 'session-catalog'),
    { maxBytes: 64 * 1024 },
  );
  if (!isJsonObject(value)) throw new Error('session-catalog must be a JSON object');
  return value;
}

function workerPlatform(): 'darwin' | 'linux' {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Local Worker service platform is unsupported');
  }
  return process.platform;
}

function preflightLocalWorkerSqlite(): void {
  preflightNodeNativeSqlite({
    allowElectronAsNode: process.platform === 'darwin' &&
      process.env.ELECTRON_RUN_AS_NODE === '1',
  });
}

function terminalServiceFlags(argv: readonly string[]): Record<string, string> {
  const required = [
    '--service-root', '--state-root', '--wrapper',
    ...(process.platform === 'darwin' ? ['--sandbox-launcher'] : []),
  ];
  return parseExactFlags(argv, argv.includes('--worker')
    ? [...required, '--worker']
    : required);
}

function providerCredentialFlags(argv: readonly string[]): Record<string, string> {
  const required = [
    '--credential', '--service-root', '--state-root', '--wrapper',
    ...(process.platform === 'darwin' ? ['--sandbox-launcher'] : []),
  ];
  return parseExactFlags(argv, argv.includes('--worker')
    ? [...required, '--worker']
    : required);
}

function terminalServiceManager(flags: Record<string, string>): LocalWorkerTerminalServiceManager {
  const platform = workerPlatform();
  return new LocalWorkerTerminalServiceManager({
    platform,
    serviceRoot: requireAbsolutePath(flags['--service-root'], 'service-root'),
    stateRoot: requireAbsolutePath(flags['--state-root'], 'state-root'),
    wrapperPath: requireAbsolutePath(flags['--wrapper'], 'wrapper'),
    ...(process.platform === 'darwin' ? {
      darwinSandboxLauncherPath: requireAbsolutePath(
        flags['--sandbox-launcher'],
        'sandbox-launcher',
      ),
    } : {}),
  });
}

export async function runLocalWorkerEntrypoint(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (command === 'check-abi') {
    if (argv.length !== 1) throw new Error('check-abi does not accept arguments');
    preflightLocalWorkerSqlite();
    return 0;
  }
  if (command === 'prepare-provider-runtime') {
    const flags = parseExactFlags(argv.slice(1), ['--root']);
    prepareProviderSessionRuntimeDirectories([
      requireAbsolutePath(flags['--root'], 'provider-runtime-root'),
    ]);
    return 0;
  }
  if (command === 'check-provider-credential') {
    const flags = parseExactFlags(argv.slice(1), ['--credential']);
    await readLocalWorkerGrokCredential(
      requireAbsolutePath(flags['--credential'], 'credential'),
    );
    return 0;
  }
  if (command === 'configure') {
    const platform = workerPlatform();
    const hasSessionCatalog = argv.includes('--session-catalog');
    const flags = parseExactFlags(argv.slice(1), [
      '--app-version', '--credential', '--runtime-module', '--runtime-read-roots',
      '--service-root', '--ssh-binary', '--state-root', '--workspace', '--wrapper',
      ...(hasSessionCatalog ? ['--session-catalog'] : []),
      ...(process.platform === 'darwin' ? [
        '--bookmark-broker',
        '--claude-executable',
        '--codex-executable',
        '--grok-executable',
        '--sandbox-launcher',
      ] : []),
    ]);
    const installed = await configureLocalWorker({
      appVersion: flags['--app-version'],
      credentialFile: flags['--credential'],
      runtimeModule: flags['--runtime-module'],
      runtimeReadRoots: runtimeReadRoots(flags['--runtime-read-roots']),
      providerSourceHome: requireAbsolutePath(process.env.HOME, 'provider-source-home'),
      runtimeOptions: {
        providerContainer: { schemaVersion: 1 },
        ...(hasSessionCatalog ? {
          sessionCreationCatalog: await sessionCreationCatalog(flags['--session-catalog']),
        } : {}),
        ...(process.platform === 'darwin' ? {
          providerSettings: {
            claudeCliPath: requireAbsolutePath(
              flags['--claude-executable'],
              'claude-executable',
            ),
            codexCliPath: requireAbsolutePath(
              flags['--codex-executable'],
              'codex-executable',
            ),
            grokCliPath: requireAbsolutePath(
              flags['--grok-executable'],
              'grok-executable',
            ),
          },
        } : {}),
      },
      sshBinary: flags['--ssh-binary'],
      stateRoot: flags['--state-root'],
      workspaceRoot: flags['--workspace'],
      platform,
      ...(process.platform === 'darwin' ? {
        workspaceBookmark: createDarwinWorkspaceBookmarkPort(
          requireAbsolutePath(flags['--bookmark-broker'], 'bookmark-broker'),
        ),
      } : {}),
    });
    try {
      await terminalServiceManager(flags).start(installed.workerConfigId);
    } catch {
      process.stderr.write('Worker 配置已保存，但后台服务未能启动；请运行 agent-deck-worker start。\n');
      return 1;
    }
    process.stdout.write(`Worker 已配置并启动：${installed.workerConfigId}\n`);
    return 0;
  }
  if (command === 'install-provider-credential') {
    const flags = providerCredentialFlags(argv.slice(1));
    const status = await terminalServiceManager(flags).installProviderCredential(
      requireAbsolutePath(flags['--credential'], 'credential'),
      flags['--worker'],
    );
    process.stdout.write(`Worker Provider 凭证已安装：${status.workerConfigId}\n`);
    return 0;
  }
  if (['start', 'status', 'stop', 'remove'].includes(command)) {
    const flags = terminalServiceFlags(argv.slice(1));
    const manager = terminalServiceManager(flags);
    const id = flags['--worker'];
    if (command === 'start') {
      const status = await manager.start(id);
      process.stdout.write(`Worker 已启动：${status.workerConfigId}\n`);
    } else if (command === 'stop') {
      const status = await manager.stop(id);
      process.stdout.write(`Worker 已停止：${status.workerConfigId}\n`);
    } else if (command === 'remove') {
      await manager.remove(id);
      process.stdout.write('Worker 本机配置已移除。\n');
    } else {
      const status = await manager.status(id);
      process.stdout.write(status.state === 'running'
        ? `Worker 状态：运行中（${status.workerConfigId}）\n`
        : status.state === 'stopped'
          ? `Worker 状态：已停止（${status.workerConfigId}）\n`
          : 'Worker 状态：尚未配置\n');
    }
    return 0;
  }
  if (!['serve', 'check-config', 'check-runtime'].includes(command)) {
    throw new Error('unknown local-worker command');
  }
  const flags = parseExactFlags(argv.slice(1), ['--config']);
  const config = parseLocalWorkerHeadlessConfig(
    await readPrivateJsonFile(flags['--config']),
  );
  if (command === 'check-config') return 0;
  if (command === 'check-runtime') {
    const module = await loadTrustedLocalWorkerRuntimeModule(config.runtimeModule);
    requireModuleFactory(module, 'createLocalWorkerRuntime');
    return 0;
  }
  if (!config.workspaceSandbox) {
    throw new Error('Local Worker serve requires a workspace sandbox');
  }
  for (const [key, value] of Object.entries(workspaceSandboxEnvironment(config.workspaceSandbox))) {
    process.env[key] = value;
  }
  preflightLocalWorkerSqlite();
  const controller = await createLocalWorkerController(config, {
    sqlitePreflight: preflightLocalWorkerSqlite,
  });
  return (await runCompositionService(controller)).exitCode;
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  const entrypointArgv = process.argv.slice(2);
  void runLocalWorkerEntrypoint(entrypointArgv).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(entrypointArgv[0] === 'check-abi'
        ? 'Local Worker 的 Node SQLite ABI 预检失败。\n'
        : entrypointArgv[0] === 'configure'
          ? 'Worker 配置失败；详细输入已隐藏。\n'
          : ['start', 'status', 'stop', 'remove', 'install-provider-credential'].includes(
            entrypointArgv[0] ?? '',
          )
            ? 'Worker 服务管理失败；详细输入已隐藏。\n'
          : 'Local Worker 启动失败；详细输入已隐藏。\n');
      process.exitCode = 1;
    },
  );
}
