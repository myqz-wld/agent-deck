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
import { FeishuControlService } from './feishu-control-service';
import {
  parseFeishuConnectRequest,
  parseFeishuDisconnectRequest,
  parseFeishuRotateCredentialRequest,
} from './feishu-request';

type ConnectionCliCommand = ServerConnectionCommand | 'list' | 'verify';

export interface ServerControlEntrypointRuntime {
  readonly uid: number | null;
  readonly readJson: typeof readPrivateJsonFile;
  readonly createConnectionService: (config: ServerControlConfig) => ServerConnectionService;
  readonly createFeishuService: (config: ServerControlConfig) => FeishuControlService;
  readonly write: (value: string) => void;
}

const HELP = `Agent Deck Server 连接管理\n\n` +
  `用法：\n` +
  `  agent-deck-server connections list --config <path>\n` +
  `  agent-deck-server connections verify --config <path>\n` +
  `  agent-deck-server connections issue --config <path> --request <path>\n` +
  `  agent-deck-server connections revoke --config <path> --request <path>\n` +
  `  agent-deck-server connections rotate --config <path> --request <path>\n` +
  `  agent-deck-server feishu check --config <path>\n` +
  `  agent-deck-server feishu dry-run --config <path> --request <path>\n` +
  `  agent-deck-server feishu connect --config <path> --request <path>\n` +
  `  agent-deck-server feishu status --config <path>\n` +
  `  agent-deck-server feishu verify --config <path>\n` +
  `  agent-deck-server feishu upgrade --config <path>\n` +
  `  agent-deck-server feishu credential rotate --config <path> --request <path>\n` +
  `  agent-deck-server feishu pair create --config <path>\n` +
  `  agent-deck-server feishu pair list --config <path>\n` +
  `  agent-deck-server feishu pair approve --config <path> --request-id <id>\n` +
  `  agent-deck-server feishu pair reject --config <path> --request-id <id>\n` +
  `  agent-deck-server feishu disconnect --config <path> --request <path>\n`;

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

function requestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value)) {
    throw new Error('Feishu pairing request id is invalid');
  }
  return value;
}

async function runConnections(
  argv: readonly string[],
  runtime: ServerControlEntrypointRuntime,
): Promise<{ command: string; result: unknown }> {
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
  return { command: `connections ${command}`, result };
}

async function runFeishu(
  argv: readonly string[],
  runtime: ServerControlEntrypointRuntime,
): Promise<{ command: string; result: unknown }> {
  const command = argv[1];
  if (!command) throw new Error('unknown Feishu command');
  if (command === 'credential') {
    if (argv[2] !== 'rotate') throw new Error('unknown Feishu credential command');
    const flags = parseExactFlags(argv.slice(3), ['--config', '--request']);
    const config = parseServerControlConfig(await runtime.readJson(flags['--config']));
    const service = runtime.createFeishuService(config);
    const result = await service.rotateCredential(parseFeishuRotateCredentialRequest(
      await runtime.readJson(flags['--request']),
    ));
    return { command: 'feishu credential rotate', result };
  }
  if (command === 'pair') {
    const operation = argv[2];
    if (!operation || !['approve', 'create', 'list', 'reject'].includes(operation)) {
      throw new Error('unknown Feishu pairing command');
    }
    const needsId = operation === 'approve' || operation === 'reject';
    const flags = parseExactFlags(
      argv.slice(3),
      needsId ? ['--config', '--request-id'] : ['--config'],
    );
    const config = parseServerControlConfig(await runtime.readJson(flags['--config']));
    const service = runtime.createFeishuService(config);
    const result = operation === 'create'
      ? await service.pairCreate()
      : operation === 'list'
        ? await service.pairList()
        : operation === 'approve'
          ? await service.pairApprove(requestId(flags['--request-id']))
          : await service.pairReject(requestId(flags['--request-id']));
    return { command: `feishu pair ${operation}`, result };
  }
  if (!['check', 'connect', 'disconnect', 'dry-run', 'status', 'upgrade', 'verify']
    .includes(command)) {
    throw new Error('unknown Feishu command');
  }
  const needsRequest = ['connect', 'disconnect', 'dry-run'].includes(command);
  const flags = parseExactFlags(
    argv.slice(2),
    needsRequest ? ['--config', '--request'] : ['--config'],
  );
  const config = parseServerControlConfig(await runtime.readJson(flags['--config']));
  const service = runtime.createFeishuService(config);
  let result: unknown;
  if (command === 'connect') {
    result = await service.connect(parseFeishuConnectRequest(
      await runtime.readJson(flags['--request']),
    ));
  } else if (command === 'dry-run') {
    result = service.dryRun(parseFeishuConnectRequest(
      await runtime.readJson(flags['--request']),
    ));
  } else if (command === 'disconnect') {
    result = await service.disconnect(parseFeishuDisconnectRequest(
      await runtime.readJson(flags['--request']),
    ));
  } else if (command === 'check') result = service.check();
  else if (command === 'status') result = await service.status();
  else if (command === 'upgrade') result = await service.upgrade();
  else result = await service.verify();
  return { command: `feishu ${command}`, result };
}

export async function runServerControlEntrypoint(
  argv: readonly string[],
  runtime: ServerControlEntrypointRuntime = {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    readJson: readPrivateJsonFile,
    createConnectionService: (config) => new ServerConnectionService(config),
    createFeishuService: (config) => new FeishuControlService(config),
    write: (value) => process.stdout.write(value),
  },
): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    runtime.write(HELP);
    return 0;
  }
  if (runtime.uid !== 0) throw new Error('server control requires root');
  const executed = argv[0] === 'connections'
    ? await runConnections(argv, runtime)
    : argv[0] === 'feishu'
      ? await runFeishu(argv, runtime)
      : (() => { throw new Error('unknown server control command family'); })();
  runtime.write(success(executed.command, executed.result));
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
