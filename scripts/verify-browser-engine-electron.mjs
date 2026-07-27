#!/usr/bin/env node
/**
 * Compile and run the browser-engine boundary fixture in a real Electron main process.
 *
 * Vitest uses Electron as Node so SQLite bindings match, but that mode cannot create real
 * BrowserWindows. This runner keeps the fixture separate from the normal unit suite and leaves no
 * generated JavaScript in the repository.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(repoRoot, 'scripts/fixtures/browser-engine-electron.ts');
const compilerPath = require.resolve('typescript/bin/tsc');
const electronPath = require('electron');
const outputRoot = mkdtempSync(join(tmpdir(), 'agent-deck-browser-electron-'));

let exitCode = 1;
try {
  const compile = spawnSync(
    process.execPath,
    [
      compilerPath,
      fixturePath,
      '--outDir',
      outputRoot,
      '--rootDir',
      repoRoot,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2022',
      '--types',
      'node',
      '--esModuleInterop',
      'true',
      '--skipLibCheck',
      'true',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    exitCode = compile.status ?? 1;
  } else {
    const compiledFixture = resolve(
      outputRoot,
      'scripts/fixtures/browser-engine-electron.js',
    );
    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronPath, [compiledFixture], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: electronEnv,
    });
    if (run.error) throw run.error;
    exitCode = run.status ?? 1;
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
process.exitCode = exitCode;
