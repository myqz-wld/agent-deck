import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('macOS Worker sandbox verification requires macOS.');
}

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'resources/native/worker-sandbox');
const output = resolve(ROOT, 'build/macos-worker-sandbox', process.arch);
const broker = resolve(output, 'agent-deck-worker-bookmark');
const launcher = resolve(output, 'agent-deck-worker-sandbox');
const workerCli = resolve(output, 'Agent Deck Worker CLI');
const workerNode = resolve(output, 'Agent Deck Worker Node');
const fixture = resolve(output, 'agent-deck-worker-sandbox-canary');
const unsignedFixture = `${fixture}-unsigned`;
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-sandbox-workspace-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-sandbox-outside-')));
const containerParent = join(
  homedir(),
  'Library/Containers/com.agentdeck.worker-sandbox/Data/Library/Application Support/Agent Deck',
);
mkdirSync(containerParent, { recursive: true, mode: 0o700 });
const privateRoot = mkdtempSync(join(containerParent, 'sandbox-check-'));
const bookmark = join(privateRoot, 'workspace.bookmark');
const providerProfile = join(privateRoot, 'provider.sb');
const workspaceCanary = join(workspace, 'inside.txt');
const outsideCanary = join(outside, 'outside.txt');

function run(executable, args) {
  return execFileSync(executable, args, { cwd: ROOT, encoding: 'utf8' });
}

function quoted(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function strictProviderProfile() {
  const roots = [workspace, output, '/bin', '/usr/bin', '/usr/lib', '/System/Library'];
  const filters = roots.map((root) => `       (subpath ${quoted(root)})`).join('\n');
  return `(version 1)\n(deny default)\n(import "system.sb")\n` +
    `(allow network*)\n(allow process-fork)\n(allow process-exec\n${filters})\n` +
    `(allow signal (target same-sandbox))\n` +
    `(allow file-read-metadata file-test-existence)\n` +
    `(allow file-read* file-map-executable file-test-existence\n${filters})\n` +
    `(allow file-write* (subpath ${quoted(workspace)}))\n`;
}

try {
  writeFileSync(workspaceCanary, 'inside\n', { mode: 0o600 });
  writeFileSync(outsideCanary, 'outside\n', { mode: 0o600 });
  run('/usr/bin/swiftc', [
    resolve(SOURCE, 'sandbox-canary.swift'),
    '-o', fixture,
    '-Xlinker', '-sectcreate',
    '-Xlinker', '__TEXT',
    '-Xlinker', '__info_plist',
    '-Xlinker', resolve(SOURCE, 'sandbox-canary-info.plist'),
  ]);
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--options', 'runtime',
    '--entitlements', resolve(SOURCE, 'worker-cli.entitlements'),
    fixture,
  ]);
  run(broker, ['create', workspace, bookmark]);
  chmodSync(bookmark, 0o600);
  writeFileSync(providerProfile, strictProviderProfile(), { mode: 0o600 });

  const directArgs = [
    '--bookmark', bookmark,
    '--workspace', workspace,
    '--', '/bin/pwd',
  ];
  const direct = run(launcher, directArgs).trim();
  if (direct !== workspace) throw new Error(`launcher cwd mismatch: ${direct}`);

  const providerArgs = [
    '--bookmark', bookmark,
    '--workspace', workspace,
    '--', '/usr/bin/sandbox-exec', '-f', providerProfile,
    fixture, workspaceCanary, outsideCanary,
  ];
  const positive = run(launcher, providerArgs).trim();
  if (positive !== 'workspace-read-ok outside-read-denied') {
    throw new Error(`unexpected provider sandbox output: ${positive}`);
  }
  const persistent = run(launcher, providerArgs).trim();
  if (persistent !== positive) {
    throw new Error(`persistent bookmark output changed: ${persistent}`);
  }

  const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', '-', launcher]);
  if (entitlements.includes('com.apple.security.app-sandbox')) {
    throw new Error('trusted launcher must allow one provider-native Seatbelt policy');
  }
  const childEntitlements = run('/usr/bin/codesign', [
    '-d', '--entitlements', '-', workerNode,
  ]);
  for (const marker of [
    'com.apple.security.cs.allow-jit',
  ]) {
    if (!childEntitlements.includes(marker)) {
      throw new Error(`Worker Node entitlement missing: ${marker}`);
    }
  }
  const cliEntitlements = run('/usr/bin/codesign', [
    '-d', '--entitlements', '-', workerCli,
  ]);
  if (cliEntitlements.includes('com.apple.security.app-sandbox')) {
    throw new Error('Worker CLI must stay outside the workspace sandbox');
  }
  if (readFileSync(bookmark).byteLength < 1) throw new Error('workspace bookmark is empty');
  process.stdout.write('[macos-worker-sandbox] bookmark and provider-native boundary passed\n');
} finally {
  rmSync(fixture, { force: true });
  rmSync(unsignedFixture, { force: true });
  rmSync(privateRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
