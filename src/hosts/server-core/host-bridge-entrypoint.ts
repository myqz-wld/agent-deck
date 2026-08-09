import {
  parseExactFlags,
  requireLinuxInstanceId,
  requireStableToken,
} from '@hosts/linux-runtime/validation';
import type { BridgeClientSurface } from '@protocol/index';

import { createProductionServerCorePodmanHost } from './podman-bridge-host';
import { runServerCorePodmanBridge } from './podman-bridge';

async function run(argv: readonly string[]): Promise<void> {
  if (argv[0] !== 'bridge') throw new Error('unknown Server Core host bridge command');
  const flags = parseExactFlags(argv.slice(1), ['--instance', '--credential', '--surface']);
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await runServerCorePodmanBridge(createProductionServerCorePodmanHost(), {
      instanceId: requireLinuxInstanceId(flags['--instance'], 'instance'),
      credentialId: requireStableToken(flags['--credential'], 'credential'),
      surface: requireClientSurface(flags['--surface']),
      originalCommand: process.env.SSH_ORIGINAL_COMMAND,
      input: process.stdin,
      output: process.stdout,
      signal: abort.signal,
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function requireClientSurface(value: string): BridgeClientSurface {
  if (value !== 'desktop-full' && value !== 'feishu-session-console') {
    throw new Error('Server Core client surface is invalid');
  }
  return value;
}

void run(process.argv.slice(2)).then(
  () => { process.exitCode = 0; },
  () => {
    process.stderr.write('Server Core SSH 桥接失败；详细输入已隐藏。\n');
    process.exitCode = 1;
  },
);
