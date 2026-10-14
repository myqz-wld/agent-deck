'use strict';

const { pathToFileURL } = require('node:url');
const { installManagedWorkerLogs, startupFailureRecord } = require('./worker-log-retention.cjs');

async function run(entrypoint, argv) {
  const configIndex = argv.indexOf('--config');
  if (argv[0] !== 'serve' || configIndex < 0 || !argv[configIndex + 1]) {
    throw new Error('invalid worker bootstrap invocation');
  }
  let managedRoot = null;
  try { managedRoot = installManagedWorkerLogs(argv[configIndex + 1]); } catch { /* Preserve original stderr. */ }
  try {
    const runtime = await import(pathToFileURL(entrypoint).href);
    process.exitCode = await runtime.runLocalWorkerEntrypoint(argv);
  } catch (error) {
    // ESM loader failures are caught here, before they can dump a repeated stack/private path.
    const code = typeof error?.code === 'string' && /^ERR_[A-Z_]{1,64}$/.test(error.code)
      ? error.code : 'WORKER_STARTUP_FAILED';
    let record = {
      timestamp: new Date().toISOString(), level: 'error', event: 'worker-startup-failed', code,
    };
    try { if (managedRoot) record = startupFailureRecord(managedRoot, code); } catch {}
    if (record) process.stderr.write(`${JSON.stringify(record)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void run(process.argv[2], process.argv.slice(3)).catch(() => { process.exitCode = 1; });
}
module.exports = { run };
