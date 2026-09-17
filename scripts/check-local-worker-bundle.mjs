import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exercise the shipped entrypoint without access to the checkout's node_modules. */
export function verifyLocalWorkerBundle(
  bundle = resolve(repoRoot, 'build/linux-headless/local-worker/index.mjs'),
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-bundle-')));
  try {
    const entrypoint = join(root, 'index.mjs');
    const config = join(root, 'worker.json');
    copyFileSync(bundle, entrypoint);
    copyFileSync(resolve(repoRoot, 'deploy/linux/relay/local-worker.config.example.json'), config);
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    execFileSync(process.execPath, [entrypoint, 'check-config', '--config', config], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLocalWorkerBundle();
}
