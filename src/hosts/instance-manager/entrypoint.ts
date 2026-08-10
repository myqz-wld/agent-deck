import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { parseExactFlags } from '@hosts/linux-runtime/validation';

import { createProductionLinuxInstanceManager } from './adapters/production';
import {
  type InstanceManagerCliCommand,
  type InstanceManagerCliRequest,
  parseInstanceManagerCliConfig,
  parseInstanceManagerCliRequest,
} from './cli-config';
import type { LinuxInstanceManager } from './manager';
import type {
  CreateInstanceRequest,
  InstanceSelector,
  UpgradeInstanceRequest,
  VersionFence,
} from './types';
import { InstanceManagerError } from './validation';

const COMMANDS = new Set<InstanceManagerCliCommand>([
  'plan-list', 'list', 'plan-create', 'create', 'plan-start', 'start',
  'plan-stop', 'stop', 'plan-status', 'status', 'describe', 'plan-upgrade', 'upgrade',
  'plan-rollback', 'rollback',
]);

function parseCommand(value: string | undefined): InstanceManagerCliCommand {
  if (!value || !COMMANDS.has(value as InstanceManagerCliCommand)) {
    throw new Error('unknown instance manager command');
  }
  return value as InstanceManagerCliCommand;
}

function isRequestless(command: InstanceManagerCliCommand): boolean {
  return command === 'plan-list' || command === 'list';
}

export async function executeInstanceManagerCommand(
  manager: LinuxInstanceManager,
  command: InstanceManagerCliCommand,
  request: InstanceManagerCliRequest | null,
): Promise<unknown> {
  switch (command) {
    case 'plan-list': return manager.planList();
    case 'list': return manager.list();
    case 'plan-create': return manager.planCreate(request as CreateInstanceRequest);
    case 'create': return manager.create(request as CreateInstanceRequest);
    case 'plan-start': return manager.planStart(request as InstanceSelector);
    case 'start': return manager.start(request as InstanceSelector);
    case 'plan-stop': return manager.planStop(request as InstanceSelector);
    case 'stop': return manager.stop(request as InstanceSelector);
    case 'plan-status': return manager.planStatus(request as InstanceSelector);
    case 'status': return manager.status(request as InstanceSelector);
    case 'describe': return manager.describe(request as InstanceSelector);
    case 'plan-upgrade': return manager.planUpgrade(request as UpgradeInstanceRequest);
    case 'upgrade': return manager.upgrade(request as UpgradeInstanceRequest);
    case 'plan-rollback': return manager.planRollback(request as VersionFence);
    case 'rollback': return manager.rollback(request as VersionFence);
  }
}

export async function runInstanceManagerEntrypoint(
  argv: readonly string[],
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  const command = parseCommand(argv[0]);
  const flags = parseExactFlags(
    argv.slice(1),
    isRequestless(command) ? ['--config'] : ['--config', '--request'],
  );
  const config = parseInstanceManagerCliConfig(await readPrivateJsonFile(flags['--config']));
  const request = isRequestless(command)
    ? null
    : parseInstanceManagerCliRequest(
      command,
      await readPrivateJsonFile(flags['--request']),
    );
  const result = await executeInstanceManagerCommand(
    createProductionLinuxInstanceManager(config),
    command,
    request,
  );
  write(`${JSON.stringify({ schemaVersion: 1, ok: true, command, result }, null, 2)}\n`);
  return 0;
}

export function instanceManagerEntrypointFailure(error: unknown): string {
  const code = error instanceof InstanceManagerError ? error.code : 'internal_error';
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    code,
    message: '实例管理操作失败；详细输入已隐藏。',
  });
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  void runInstanceManagerEntrypoint(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${instanceManagerEntrypointFailure(error)}\n`);
      process.exitCode = 1;
    },
  );
}
