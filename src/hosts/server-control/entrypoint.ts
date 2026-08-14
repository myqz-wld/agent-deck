import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { parseExactFlags } from '@hosts/linux-runtime/validation';

import { parseServerControlConfig, type ServerControlConfig } from './config';
import {
  parseServerConnectionRequest,
  type ServerConnectionCommand,
} from './connection-request';
import { ServerConnectionService } from './connection-service';

type ConnectionCliCommand = ServerConnectionCommand | 'list' | 'verify';

export interface ServerControlEntrypointRuntime {
  readonly uid: number | null;
  readonly readJson: typeof readPrivateJsonFile;
  readonly createConnectionService: (config: ServerControlConfig) => ServerConnectionService;
  readonly write: (value: string) => void;
}

const HELP = `Agent Deck Server 连接管理\n\n` +
  `用法：\n` +
  `  agent-deck-server connections list --config <path>\n` +
  `  agent-deck-server connections verify --config <path>\n` +
  `  agent-deck-server connections issue --config <path> --request <path>\n` +
  `  agent-deck-server connections revoke --config <path> --request <path>\n` +
  `  agent-deck-server connections rotate --config <path> --request <path>\n`;

function connectionCommand(value: string | undefined): ConnectionCliCommand {
  if (!value || !['issue', 'list', 'revoke', 'rotate', 'verify'].includes(value)) {
    throw new Error('unknown connection command');
  }
  return value as ConnectionCliCommand;
}

function success(command: string, result: unknown): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    command,
    result,
  }, null, 2)}\n`;
}

export async function runServerControlEntrypoint(
  argv: readonly string[],
  runtime: ServerControlEntrypointRuntime = {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    readJson: readPrivateJsonFile,
    createConnectionService: (config) => new ServerConnectionService(config),
    write: (value) => process.stdout.write(value),
  },
): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    runtime.write(HELP);
    return 0;
  }
  if (runtime.uid !== 0) throw new Error('server control requires root');
  if (argv[0] !== 'connections') throw new Error('unknown server control command family');
  const command = connectionCommand(argv[1]);
  const needsRequest = command !== 'list' && command !== 'verify';
  const flags = parseExactFlags(
    argv.slice(2),
    needsRequest ? ['--config', '--request'] : ['--config'],
  );
  const config = parseServerControlConfig(await runtime.readJson(flags['--config']));
  const service = runtime.createConnectionService(config);
  let result: unknown;
  if (command === 'list') result = service.list();
  else if (command === 'verify') result = service.verify();
  else if (command === 'issue') {
    result = service.issue(parseServerConnectionRequest(
      'issue',
      await runtime.readJson(flags['--request']),
    ));
  } else if (command === 'revoke') {
    result = service.revoke(parseServerConnectionRequest(
      'revoke',
      await runtime.readJson(flags['--request']),
    ));
  } else {
    result = service.rotate(parseServerConnectionRequest(
      'rotate',
      await runtime.readJson(flags['--request']),
    ));
  }
  runtime.write(success(`connections ${command}`, result));
  return 0;
}

export function serverControlEntrypointFailure(): string {
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    code: 'operation_failed',
    message: 'Server 连接管理操作失败；详细输入已隐藏。',
  });
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  void runServerControlEntrypoint(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write(`${serverControlEntrypointFailure()}\n`);
      process.exitCode = 1;
    },
  );
}
