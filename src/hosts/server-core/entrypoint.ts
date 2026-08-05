import { createConnection } from 'node:net';

import { preflightNodeNativeSqlite } from '@hosts/daemon/sqlite-preflight';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { runForcedCommandTunnel } from '@hosts/linux-runtime/forced-command';
import { runCompositionService } from '@hosts/linux-runtime/service-runner';
import {
  parseExactFlags,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

import { parseServerCoreConfig } from './config';
import { createServerCoreController } from './root';

async function probeSocket(socketPath: string): Promise<void> {
  requireAbsolutePath(socketPath, 'socket');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('health probe timed out'));
    }, 3_000);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

async function bridge(
  flags: Readonly<Record<string, string>>,
  originalCommand: string | undefined,
  expectedOriginalCommand: string,
): Promise<void> {
  const instanceId = requireLinuxInstanceId(flags['--instance'], 'instance');
  const credentialId = requireStableToken(flags['--credential'], 'credential');
  const surface = requireClientSurface(flags['--surface']);
  const socketPath = requireAbsolutePath(flags['--socket'], 'socket');
  if (socketPath !== `/run/agent-deck/${instanceId}/agent-deckd.sock`) {
    throw new Error('Server Core bridge socket is outside its exact instance namespace');
  }
  await runForcedCommandTunnel({
    admission: {
      version: 1,
      topology: 'server-core',
      role: 'client',
      instanceId,
      credentialId,
      surface,
    },
    socketPath,
    expectedOriginalCommand,
    originalCommand,
    input: process.stdin,
    output: process.stdout,
  });
}

async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (command === 'check-abi') {
    if (argv.length !== 1) throw new Error('check-abi does not accept arguments');
    preflightNodeNativeSqlite();
    return 0;
  }
  if (command === 'health') {
    const flags = parseExactFlags(argv.slice(1), ['--socket']);
    await probeSocket(flags['--socket']);
    return 0;
  }
  if (command === 'bridge') {
    const flags = parseExactFlags(
      argv.slice(1),
      ['--instance', '--credential', '--surface', '--socket'],
    );
    await bridge(flags, process.env.SSH_ORIGINAL_COMMAND, 'agent-deck-bridge');
    return 0;
  }
  if (command === 'bridge-internal') {
    const flags = parseExactFlags(
      argv.slice(1),
      ['--instance', '--credential', '--surface', '--socket'],
    );
    await bridge(flags, 'verified-rootless-podman-exec', 'verified-rootless-podman-exec');
    return 0;
  }
  if (command === 'check-config') {
    const flags = parseExactFlags(argv.slice(1), ['--config']);
    parseServerCoreConfig(await readPrivateJsonFile(flags['--config']));
    return 0;
  }
  if (command !== 'serve') throw new Error('unknown server-core command');
  const flags = parseExactFlags(argv.slice(1), ['--instance', '--config', '--socket']);
  const config = parseServerCoreConfig(await readPrivateJsonFile(flags['--config']));
  if (
    config.instanceId !== requireLinuxInstanceId(flags['--instance'], 'instance') ||
    config.socketPath !== flags['--socket']
  ) {
    throw new Error('server-core argv/config instance binding mismatch');
  }
  preflightNodeNativeSqlite();
  const controller = await createServerCoreController(config);
  const result = await runCompositionService(controller);
  return result.exitCode;
}

function requireClientSurface(value: string): 'desktop-full' | 'feishu-session-console' {
  if (value !== 'desktop-full' && value !== 'feishu-session-console') {
    throw new Error('Server Core client surface is invalid');
  }
  return value;
}

const entrypointArgv = process.argv.slice(2);
void run(entrypointArgv).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write(entrypointArgv[0] === 'check-abi'
      ? 'Server Core 的 Node SQLite ABI 预检失败。\n'
      : 'Server Core 启动失败；详细输入已隐藏。\n');
    process.exitCode = 1;
  },
);
