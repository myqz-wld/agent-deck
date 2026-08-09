import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  parseExactFlags,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requirePositiveInteger,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

import { parseProviderSessionSupervisorHostConfig } from './host-config';
import {
  createProviderSessionSupervisorHost,
  runProviderSessionSupervisorService,
} from './host-service';
import { ProviderSessionSupervisorTransportClient } from './supervisor-transport-client';
import { providerSessionRuntimePaths } from './runtime-paths';
import { prepareProviderSessionRuntimeDirectories } from './runtime-directories';
import { openProviderSessionTransportPath } from './node-transport-path';

const MAX_CONFIG_BYTES = 64 * 1024;

async function readConfig(path: string) {
  return parseProviderSessionSupervisorHostConfig(await readPrivateJsonFile(path, {
    maxBytes: MAX_CONFIG_BYTES,
  }));
}

async function readCapabilities(
  config: Awaited<ReturnType<typeof readConfig>>,
): Promise<void> {
  const path = openProviderSessionTransportPath({
    platform: process.platform,
    privateRoot: config.privateRoot,
    socketPath: config.transportSocketPath,
  });
  try {
    const client = new ProviderSessionSupervisorTransportClient({
      requestTimeoutMs: 3_000,
      socketPath: path.connectPath,
    });
    await client.capabilities();
  } finally {
    path.close();
  }
}

function prepareRuntime(config: Awaited<ReturnType<typeof readConfig>>): void {
  prepareProviderSessionRuntimeDirectories([
    config.privateRoot,
    config.stateRoot,
    config.brokerRoot,
    config.transportRuntimeDirectory,
  ]);
}

export function providerSessionSupervisorEntrypointFailureMessage(
  argv: readonly string[],
  error: unknown,
): string {
  const command = argv[0] ?? 'serve';
  if (command === 'serve') return 'Provider supervisor 启动失败；详细输入已隐藏。';
  const messages = error instanceof Error
    ? [error.message, error.cause instanceof Error ? error.cause.message : '']
    : ['未知错误'];
  const detail = messages.filter((message, index) => message && messages.indexOf(message) === index)
    .join('：')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')
    .trim()
    .slice(0, 512) || '未知错误';
  return `Provider supervisor ${command} 失败：${detail}`;
}

async function waitReady(
  config: Awaited<ReturnType<typeof readConfig>>,
  deadlineMs: number,
): Promise<void> {
  const deadlineAt = Date.now() + deadlineMs;
  let lastError: unknown = null;
  while (Date.now() < deadlineAt) {
    try {
      await readCapabilities(config);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Provider supervisor readiness timed out', { cause: lastError });
}

export async function runProviderSessionSupervisorEntrypoint(
  argv: readonly string[],
): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (command === 'runtime-paths') {
    const hasWorker = argv.slice(1).includes('--worker-config');
    const flags = parseExactFlags(argv.slice(1), [
      '--instance', '--runtime-parent', '--uid',
      ...(hasWorker ? ['--worker-config'] : []),
    ]);
    const paths = providerSessionRuntimePaths({
      instanceId: requireLinuxInstanceId(flags['--instance']),
      platform: process.platform,
      runtimeParent: requireAbsolutePath(flags['--runtime-parent'], 'runtime-parent'),
      uid: requirePositiveInteger(Number(flags['--uid']), 'uid'),
      ...(hasWorker ? {
        workerConfigId: requireStableToken(flags['--worker-config'], 'worker-config'),
      } : {}),
    });
    process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
    return 0;
  }
  if (command === 'check-config') {
    const flags = parseExactFlags(argv.slice(1), ['--config']);
    await readConfig(flags['--config']);
    return 0;
  }
  if (command === 'prepare-runtime') {
    const flags = parseExactFlags(argv.slice(1), ['--config']);
    prepareRuntime(await readConfig(flags['--config']));
    return 0;
  }
  if (command === 'health-config') {
    const flags = parseExactFlags(argv.slice(1), ['--config']);
    await readCapabilities(await readConfig(flags['--config']));
    return 0;
  }
  if (command === 'wait-ready') {
    const flags = parseExactFlags(argv.slice(1), ['--config', '--deadline-ms']);
    await waitReady(
      await readConfig(flags['--config']),
      requirePositiveInteger(Number(flags['--deadline-ms']), 'deadline-ms', 120_000),
    );
    return 0;
  }
  if (command === 'health') {
    const flags = parseExactFlags(argv.slice(1), ['--socket']);
    const client = new ProviderSessionSupervisorTransportClient({
      requestTimeoutMs: 3_000,
      socketPath: flags['--socket'],
    });
    await client.capabilities();
    return 0;
  }
  if (command !== 'serve') throw new Error('unknown Provider supervisor command');
  const flags = parseExactFlags(argv.slice(1), ['--instance', '--config', '--socket']);
  const config = await readConfig(flags['--config']);
  if (config.instanceId !== flags['--instance'] ||
      config.transportSocketPath !== flags['--socket']) {
    throw new Error('Provider supervisor argv/config identity mismatch');
  }
  prepareRuntime(config);
  const service = createProviderSessionSupervisorHost(config);
  return (await runProviderSessionSupervisorService(service)).exitCode;
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  void runProviderSessionSupervisorEntrypoint(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${providerSessionSupervisorEntrypointFailureMessage(
        process.argv.slice(2), error,
      )}\n`);
      process.exitCode = 1;
    },
  );
}
