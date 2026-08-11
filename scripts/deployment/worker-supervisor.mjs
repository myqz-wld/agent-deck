import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { runCommand } from './process.mjs';

const COMMAND_TIMEOUT_MS = 180_000;
const MAX_PLIST_BYTES = 128 * 1024;

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function command(executable, args, options = {}) {
  return runCommand(executable, args, {
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
    ...options,
  });
}

function identity(config) {
  return {
    label: `com.agentdeck.provider-supervisor.${config.hostConfig.instanceId}`,
    target: `gui/${process.getuid()}/com.agentdeck.provider-supervisor.${config.hostConfig.instanceId}`,
  };
}

async function assertRuntimePaths(config) {
  const result = await command(config.command, [
    'runtime-paths',
    '--instance', config.hostConfig.instanceId,
    '--runtime-parent', dirname(config.hostConfig.privateRoot),
    '--uid', String(process.getuid()),
    '--worker-config', config.workerConfigId,
  ]);
  let paths;
  try { paths = JSON.parse(result.stdout); } catch {
    throw new Error('Provider supervisor runtime-paths 返回了无效结果。');
  }
  const expected = {
    privateRoot: config.hostConfig.privateRoot,
    stateRoot: config.hostConfig.stateRoot,
    brokerRoot: config.hostConfig.brokerRoot,
    supervisorRoot: config.hostConfig.transportRuntimeDirectory,
    supervisorSocketPath: config.hostConfig.transportSocketPath,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (paths?.[key] !== value) {
      throw new Error(`Provider supervisor ${key} 与 Worker identity 不匹配。`);
    }
  }
}

export async function checkWorkerProviderSupervisor(config) {
  if (config === null) return { managed: false };
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new Error('Relay Worker Provider supervisor 官方部署当前仅支持 macOS LaunchAgent。');
  }
  await command(config.command, ['check-config', '--config', config.configFile]);
  await command(config.workerWrapper, [
    'check-provider-credential', '--credential', config.grokCredentialFile,
  ]);
  await assertRuntimePaths(config);
  return { managed: true, instanceId: config.hostConfig.instanceId };
}

function launchAgentPath(config) {
  return join(
    homedir(),
    'Library',
    'LaunchAgents',
    `com.agentdeck.provider-supervisor.${config.hostConfig.instanceId}.plist`,
  );
}

async function renderLaunchAgent(config) {
  const template = await readFile(config.templateFile, 'utf8');
  const replacements = {
    '@@INSTANCE_ID@@': config.hostConfig.instanceId,
    '@@SUPERVISOR_COMMAND@@': config.command,
    '@@CONFIG_PATH@@': config.configFile,
    '@@SOCKET_PATH@@': config.hostConfig.transportSocketPath,
  };
  let rendered = template;
  for (const [marker, value] of Object.entries(replacements)) {
    if (!rendered.includes(marker)) throw new Error(`Provider LaunchAgent 缺少 ${marker}。`);
    rendered = rendered.replaceAll(marker, xml(value));
  }
  if (rendered.includes('@@') || Buffer.byteLength(rendered) > MAX_PLIST_BYTES) {
    throw new Error('Provider LaunchAgent 渲染结果无效。');
  }
  return rendered;
}

async function readExistingPrivateFile(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const uid = process.getuid();
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== uid || stat.size > MAX_PLIST_BYTES || await realpath(path) !== path) {
    throw new Error('现有 Provider LaunchAgent 文件不可信。');
  }
  return readFile(path);
}

async function writePrivateAtomic(path, bytes) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error('LaunchAgents 目录不规范。');
  const staged = join(parent, `.agent-deck-provider-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(staged, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(staged, 0o600);
    await rename(staged, path);
    const installed = await lstat(path);
    if (!installed.isFile() || installed.isSymbolicLink() ||
        (installed.mode & 0o777) !== 0o600 || installed.uid !== process.getuid()) {
      throw new Error('Provider LaunchAgent 安装后校验失败。');
    }
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close();
    try { await unlink(staged); } catch {}
    throw error;
  }
}

async function restoreLaunchAgent(path, previous) {
  if (previous === null) {
    const existing = await readExistingPrivateFile(path);
    if (existing !== null) await unlink(path);
    return;
  }
  await writePrivateAtomic(path, previous);
}

async function launchctl(args, allowFailure = false) {
  return command('/bin/launchctl', args, { allowFailure, timeoutMs: 30_000 });
}

async function verifyLaunchAgent(config) {
  const { target } = identity(config);
  const status = await launchctl(['print', target], true);
  if (status.code !== 0 || !/^\s*state = running\s*$/m.test(status.stdout)) {
    throw new Error('Provider supervisor LaunchAgent 尚未运行。');
  }
  await command(config.command, ['health-config', '--config', config.configFile]);
}

export async function verifyWorkerProviderSupervisor(config) {
  if (config === null) return { managed: false };
  await checkWorkerProviderSupervisor(config);
  await verifyLaunchAgent(config);
  return { managed: true, instanceId: config.hostConfig.instanceId, status: 'running' };
}

export async function deployWorkerProviderSupervisor(config) {
  if (config === null) return { managed: false };
  await checkWorkerProviderSupervisor(config);
  await command(config.workerWrapper, [
    'install-provider-credential',
    '--credential', config.grokCredentialFile,
    '--worker', config.workerConfigId,
  ]);
  await command(config.command, ['prepare-runtime', '--config', config.configFile]);
  const plistPath = launchAgentPath(config);
  const previous = await readExistingPrivateFile(plistPath);
  const rendered = Buffer.from(await renderLaunchAgent(config), 'utf8');
  const { target } = identity(config);
  try {
    await writePrivateAtomic(plistPath, rendered);
    const current = await launchctl(['print', target], true);
    if (current.code === 0) {
      const stopped = await launchctl(['bootout', target], true);
      if (stopped.code !== 0) throw new Error('现有 Provider supervisor 无法受控停止。');
    }
    await launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath]);
    await command(config.command, [
      'wait-ready', '--config', config.configFile, '--deadline-ms', '120000',
    ], { timeoutMs: 150_000 });
    await verifyLaunchAgent(config);
  } catch (error) {
    await launchctl(['bootout', target], true).catch(() => undefined);
    await restoreLaunchAgent(plistPath, previous).catch(() => undefined);
    if (previous !== null) {
      await launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath], true)
        .catch(() => undefined);
    }
    throw error;
  } finally {
    rendered.fill(0);
    previous?.fill(0);
  }
  return {
    managed: true,
    instanceId: config.hostConfig.instanceId,
    launchAgent: basename(plistPath),
    status: 'running',
  };
}
