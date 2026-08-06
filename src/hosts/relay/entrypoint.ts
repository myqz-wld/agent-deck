import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Duplex, Readable, Writable } from 'node:stream';

import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { runForcedCommandTunnel } from '@hosts/linux-runtime/forced-command';
import { runCompositionService } from '@hosts/linux-runtime/service-runner';
import {
  parseExactFlags,
  requireAbsolutePath,
  requireLinuxInstanceId,
} from '@hosts/linux-runtime/validation';
import { connectUnixSocket } from '@hosts/ssh-bridge/tunnel';

import { parseRelayForcedCommand } from './entrypoint-command';
import { resolveRelayForcedCommandBinding } from './forced-command-binding';
import { parseRelayHeadlessConfig } from './headless-config';
import { createRelayController } from './headless-root';
import { issueRelayConnection } from './connection-issuer';

export interface RelayForcedCommandRuntime {
  readonly serviceUid: number;
  readonly originalCommand: string | undefined;
  readonly input: Readable;
  readonly output: Writable;
  readonly connect?: (socketPath: string) => Promise<Duplex>;
}

/** Runs only attach/bridge and returns false for non-forced-command entrypoint modes. */
export async function runRelayForcedCommand(
  argv: readonly string[],
  runtime: RelayForcedCommandRuntime,
): Promise<boolean> {
  const parsed = parseRelayForcedCommand(argv);
  if (!parsed) return false;
  const binding = resolveRelayForcedCommandBinding(
    parsed.role,
    parsed.flags,
    runtime.serviceUid,
  );
  await runForcedCommandTunnel({
    admission: binding.admission,
    socketPath: binding.socketPath,
    expectedOriginalCommand: binding.expectedOriginalCommand,
    originalCommand: runtime.originalCommand,
    input: runtime.input,
    output: runtime.output,
    connect: runtime.connect,
  });
  return true;
}

async function probeRelayControlSocket(socketPath: string): Promise<void> {
  const socket = await connectUnixSocket(socketPath);
  socket.destroy();
}

export async function runRelayEntrypoint(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (await runRelayForcedCommand(argv, {
    serviceUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    originalCommand: process.env.SSH_ORIGINAL_COMMAND,
    input: process.stdin,
    output: process.stdout,
  })) {
    return 0;
  }
  if (command === 'health') {
    const flags = parseExactFlags(argv.slice(1), ['--socket']);
    await probeRelayControlSocket(requireAbsolutePath(flags['--socket'], 'socket'));
    return 0;
  }
  if (command === 'check-config') {
    const flags = parseExactFlags(argv.slice(1), ['--config']);
    parseRelayHeadlessConfig(await readPrivateJsonFile(flags['--config']));
    return 0;
  }
  if (command === 'issue-connection') {
    const flags = parseExactFlags(argv.slice(1), [
      '--instance', '--credential', '--label', '--hostname', '--port', '--username',
      '--host-key', '--config', '--authorized-keys', '--runtime-uid', '--output',
    ]);
    issueRelayConnection(flags);
    return 0;
  }
  if (command !== 'serve') throw new Error('unknown Relay command');
  const flags = parseExactFlags(argv.slice(1), [
    '--instance',
    '--config',
    '--state',
    '--control-socket',
  ]);
  const config = parseRelayHeadlessConfig(await readPrivateJsonFile(flags['--config']));
  if (config.instanceId !== requireLinuxInstanceId(flags['--instance'], 'instance')) {
    throw new Error('Relay instance mismatch');
  }
  const controller = await createRelayController(config, {
    stateDirectory: requireAbsolutePath(flags['--state'], 'state'),
    controlSocket: requireAbsolutePath(flags['--control-socket'], 'control-socket'),
  });
  return (await runCompositionService(controller)).exitCode;
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  void runRelayEntrypoint(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('Relay 启动失败；详细输入已隐藏。\n');
      process.exitCode = 1;
    },
  );
}
