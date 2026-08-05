import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import { runCompositionService } from '@hosts/linux-runtime/service-runner';
import { parseExactFlags } from '@hosts/linux-runtime/validation';
import { preflightNodeNativeSqlite } from '@hosts/daemon/sqlite-preflight';

import { parseLocalWorkerHeadlessConfig } from './headless-config';
import { createLocalWorkerController } from './headless-root';

async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (command === 'check-abi') {
    if (argv.length !== 1) throw new Error('check-abi does not accept arguments');
    preflightNodeNativeSqlite();
    return 0;
  }
  if (command !== 'serve' && command !== 'check-config') {
    throw new Error('unknown local-worker command');
  }
  const flags = parseExactFlags(argv.slice(1), ['--config']);
  const config = parseLocalWorkerHeadlessConfig(
    await readPrivateJsonFile(flags['--config']),
  );
  if (command === 'check-config') return 0;
  preflightNodeNativeSqlite();
  const controller = await createLocalWorkerController(config);
  return (await runCompositionService(controller)).exitCode;
}

const entrypointArgv = process.argv.slice(2);
void run(entrypointArgv).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write(entrypointArgv[0] === 'check-abi'
      ? 'Local Worker 的 Node SQLite ABI 预检失败。\n'
      : 'Local Worker 启动失败；详细输入已隐藏。\n');
    process.exitCode = 1;
  },
);
