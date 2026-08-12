import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'resources/native/worker-sandbox');

function resolvePackageNodeModules() {
  let current = ROOT;
  while (true) {
    const candidate = resolve(current, 'node_modules');
    if (existsSync(resolve(candidate, 'electron/package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new Error('Unable to locate installed package dependencies.');
    current = parent;
  }
}

const packageNodeModules = resolvePackageNodeModules();
const electronRoot = realpathSync(resolve(packageNodeModules, 'electron'));
const requestedArchIndex = process.argv.indexOf('--arch');
const requestedArch = requestedArchIndex >= 0 ? process.argv[requestedArchIndex + 1] : process.arch;
if (process.platform !== 'darwin') {
  throw new Error('macOS Worker sandbox helpers can only be built on macOS.');
}
if (!['arm64', 'x64'].includes(requestedArch)) {
  throw new Error('Usage: node scripts/build-macos-worker-sandbox.mjs [--arch arm64|x64]');
}

const output = resolve(ROOT, 'build/macos-worker-sandbox', requestedArch);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o755 });

function run(executable, args) {
  execFileSync(executable, args, { cwd: ROOT, stdio: 'inherit' });
}

function compile(source, destination, infoPlist) {
  const args = [
    resolve(SOURCE, source),
    '-o', resolve(output, destination),
    '-Xlinker', '-sectcreate',
    '-Xlinker', '__TEXT',
    '-Xlinker', '__info_plist',
    '-Xlinker', resolve(SOURCE, infoPlist),
  ];
  if (requestedArch !== process.arch) {
    args.push('-target', `${requestedArch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos11`);
  }
  run('/usr/bin/swiftc', args);
}

function nestedPackageRoot(parentPackage, childPackage) {
  const parentRoot = realpathSync(resolve(packageNodeModules, parentPackage));
  const nestedRequire = createRequire(resolve(parentRoot, 'package.json'));
  return dirname(nestedRequire.resolve(`${childPackage}/package.json`));
}

function signWorkerRuntime(executable) {
  chmodSync(executable, 0o755);
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--options', 'runtime',
    '--entitlements', resolve(SOURCE, 'worker-cli.entitlements'),
    executable,
  ]);
  run('/usr/bin/codesign', ['--verify', '--strict', executable]);
}

compile('bookmark-broker.swift', 'agent-deck-worker-bookmark', 'bookmark-broker-info.plist');
compile('worker-launcher.swift', 'agent-deck-worker-sandbox', 'worker-launcher-info.plist');
const workerCli = resolve(output, 'Agent Deck Worker CLI');
const workerNode = resolve(output, 'Agent Deck Worker Node');
const electronNode = resolve(electronRoot, 'dist/Electron.app/Contents/MacOS/Electron');
for (const destination of [workerCli, workerNode]) {
  copyFileSync(electronNode, destination);
  chmodSync(destination, 0o755);
}

run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--options', 'runtime',
  resolve(output, 'agent-deck-worker-bookmark'),
]);
run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--options', 'runtime',
  resolve(output, 'agent-deck-worker-sandbox'),
]);
run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--options', 'runtime',
  '--entitlements', resolve(SOURCE, 'worker-cli.entitlements'),
  workerCli,
]);
run('/usr/bin/codesign', [
  '--force', '--sign', '-', '--options', 'runtime',
  '--entitlements', resolve(SOURCE, 'worker-cli.entitlements'),
  workerNode,
]);
run('/usr/bin/codesign', ['--verify', '--strict', resolve(output, 'agent-deck-worker-bookmark')]);
run('/usr/bin/codesign', ['--verify', '--strict', resolve(output, 'agent-deck-worker-sandbox')]);
run('/usr/bin/codesign', ['--verify', '--strict', workerCli]);
run('/usr/bin/codesign', ['--verify', '--strict', workerNode]);

const nativeArch = requestedArch === 'arm64' ? 'arm64' : 'x64';
const codexTriple = requestedArch === 'arm64'
  ? 'aarch64-apple-darwin'
  : 'x86_64-apple-darwin';
const providers = resolve(output, 'providers');
const claudeRoot = resolve(providers, 'claude');
const codexRoot = resolve(providers, 'codex');
const grokRoot = resolve(providers, 'grok');
mkdirSync(claudeRoot, { recursive: true, mode: 0o755 });
mkdirSync(grokRoot, { recursive: true, mode: 0o755 });

const claudeSource = resolve(nestedPackageRoot(
  '@anthropic-ai/claude-agent-sdk',
  `@anthropic-ai/claude-agent-sdk-darwin-${nativeArch}`,
), 'claude');
const claudeExecutable = resolve(claudeRoot, 'claude');
copyFileSync(claudeSource, claudeExecutable);
signWorkerRuntime(claudeExecutable);

const codexPackage = nestedPackageRoot(
  '@openai/codex',
  `@openai/codex-darwin-${nativeArch}`,
);
cpSync(resolve(codexPackage, 'vendor', codexTriple), codexRoot, {
  recursive: true,
  dereference: true,
});
for (const executable of [
  resolve(codexRoot, 'bin/codex'),
  resolve(codexRoot, 'bin/codex-code-mode-host'),
  resolve(codexRoot, 'codex-path/rg'),
  resolve(codexRoot, 'codex-resources/zsh/bin/zsh'),
]) signWorkerRuntime(executable);

const grokPackage = nestedPackageRoot(
  '@xai-official/grok',
  `@xai-official/grok-darwin-${nativeArch}`,
);
const grokCompressed = readFileSync(resolve(grokPackage, 'bin/grok.br'));
const grokExecutable = resolve(grokRoot, 'grok');
const grokBinary = brotliDecompressSync(grokCompressed);
try {
  writeFileSync(grokExecutable, grokBinary, { mode: 0o755 });
} finally {
  grokBinary.fill(0);
}
signWorkerRuntime(grokExecutable);

process.stdout.write(`[macos-worker-sandbox] built ${requestedArch} helpers at ${output}\n`);
