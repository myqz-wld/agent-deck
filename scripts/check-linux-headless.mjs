#!/usr/bin/env node

import {
  chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  LINUX_HEADLESS_SOURCE_ROOTS,
  fail,
  filesUnder,
  run,
  runOutput,
  verifyIssuedConnectionBundles,
  verifyLinuxPackageAndRuntimeArtifacts,
  verifyRelayBundleForcedCommands,
  verifyServerCoreRuntimeBundleLoads,
} from './check-linux-headless-support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(repoRoot, 'build/linux-headless');
for (const root of LINUX_HEADLESS_SOURCE_ROOTS) {
  for (const file of filesUnder(resolve(repoRoot, root))) {
    if (!['.ts', '.tsx'].includes(extname(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n').length - 1;
    if (lines >= 500) fail(`${relative(repoRoot, file)} has ${lines} lines`);
    if (!file.endsWith('.test.ts') && /(?:from|import\()\s*['"]electron(?:['"/])/.test(readFileSync(file, 'utf8'))) {
      fail(`${relative(repoRoot, file)} imports Electron`);
    }
  }
}

const { packageFixture, builtManifest } = verifyLinuxPackageAndRuntimeArtifacts();

for (const entry of Object.values(builtManifest.entries)) {
  if (!statSync(resolve(outputRoot, entry), { throwIfNoEntry: false })?.isFile()) {
    fail(`missing built entry ${entry}`);
  }
}
const relayFiles = filesUnder(resolve(outputRoot, 'relay'));
const relayBundle = relayFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
for (const forbidden of [
  'better-sqlite3',
  'createServerCoreController',
  'SessionConsoleDaemonRuntime',
  '@openai/codex',
  '@anthropic-ai/claude-agent-sdk',
  '@xai-official/grok',
]) {
  if (relayBundle.includes(forbidden)) fail(`Relay artifact contains ${forbidden}`);
}
if (/(?:from|import\()\s*['"]electron(?:['"/])/.test(relayBundle)) {
  fail('Relay artifact imports Electron');
}
for (const role of ['server-core', 'local-worker']) {
  const bundle = filesUnder(resolve(outputRoot, role))
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  if (!bundle.includes('check-abi') || !bundle.includes('better-sqlite3')) {
    fail(`${role} artifact lost its Node-native SQLite ABI preflight`);
  }
  if (role === 'server-core' && bundle.includes('/usr/bin/podman')) {
    fail('Server Core container artifact contains the host Podman bridge');
  }
}
const localWorkerBundle = filesUnder(resolve(outputRoot, 'local-worker'))
  .map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'LocalWorkerTerminalServiceManager',
  'Worker 已配置并启动',
  '/bin/launchctl',
  '/usr/bin/systemctl',
  '/usr/bin/bwrap',
  'workspace.bookmark',
  '--bookmark',
]) {
  if (!localWorkerBundle.includes(required)) {
    fail(`Local Worker artifact lost terminal lifecycle ${required}`);
  }
}
const serverCoreRuntimeBundle = filesUnder(resolve(outputRoot, 'server-core-runtime'))
  .map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'createServerCoreRuntime',
  '/run/secrets/agent-deck/credentials.json',
  '/opt/agent-deck/providers/claude/claude',
  '/opt/agent-deck/providers/codex/codex',
  '/opt/agent-deck/providers/grok/grok',
  'better-sqlite3',
]) {
  if (!serverCoreRuntimeBundle.includes(required)) {
    fail(`Server Core runtime artifact lost ${required}`);
  }
}
for (const forbidden of [
  '/usr/bin/podman',
  'createDesktopAdapterRegistry',
  'RelayControlHost',
]) {
  if (serverCoreRuntimeBundle.includes(forbidden)) {
    fail(`Server Core runtime artifact contains ${forbidden}`);
  }
}
if (/(?:from|import\()\s*['"]electron(?:['"/])/.test(serverCoreRuntimeBundle)) {
  fail('Server Core runtime artifact imports Electron');
}
const localWorkerRuntimeBundle = filesUnder(resolve(outputRoot, 'local-worker-runtime'))
  .map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'createLocalWorkerRuntime',
  'local-worker',
  'better-sqlite3',
  '/opt/agent-deck/providers/claude/claude',
]) {
  if (!localWorkerRuntimeBundle.includes(required)) {
    fail(`Local Worker runtime artifact lost ${required}`);
  }
}
for (const forbidden of ['/usr/bin/podman', 'RelayControlHost']) {
  if (localWorkerRuntimeBundle.includes(forbidden)) {
    fail(`Local Worker runtime artifact contains ${forbidden}`);
  }
}
if (/(?:from|import\()\s*['"]electron(?:['"/])/.test(localWorkerRuntimeBundle)) {
  fail('Local Worker runtime artifact imports Electron');
}
const providerSessionBundle = filesUnder(resolve(outputRoot, 'provider-session'))
  .map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'runProviderSessionShim',
  '/run/agent-deck/inference.sock',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'GROK_XAI_API_BASE_URL',
  'stdio-multiplex-v1',
  'unix-http-v1',
  'agent-deck-session-broker',
]) {
  if (!providerSessionBundle.includes(required)) {
    fail(`Provider session artifact lost ${required}`);
  }
}
const providerSessionSupervisorBundle = filesUnder(
  resolve(outputRoot, 'provider-session-supervisor'),
).map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'runProviderSessionSupervisorEntrypoint',
  'rootless-podman',
  'docker-desktop',
  'runtime-paths',
  'wait-ready',
  '/proc/self/fd',
  'provider runtime image must be pinned by SHA-256 digest',
]) {
  if (!providerSessionSupervisorBundle.includes(required)) {
    fail(`Provider supervisor artifact lost ${required}`);
  }
}
for (const forbidden of [
  'SERVER_CORE_PROVIDER_AUTH_SOURCE',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'ServerCoreProviderInferenceBroker',
]) {
  if (providerSessionSupervisorBundle.includes(forbidden)) {
    fail(`Provider supervisor artifact contains Core-only authority ${forbidden}`);
  }
}
for (const forbidden of [
  '/usr/bin/podman',
  '/var/run/docker.sock',
  'SERVER_CORE_PROVIDER_AUTH_SOURCE',
]) {
  if (providerSessionBundle.includes(forbidden)) {
    fail(`Provider session artifact contains ${forbidden}`);
  }
}
const allowedRuntimeExternals = new Set([
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);
for (const match of serverCoreRuntimeBundle.matchAll(/^import .* from "([^"]+)";/gm)) {
  if (!allowedRuntimeExternals.has(match[1])) {
    fail(`Server Core runtime has an unpackaged external import: ${match[1]}`);
  }
}
verifyServerCoreRuntimeBundleLoads();
verifyIssuedConnectionBundles();
const feishuBundle = filesUnder(resolve(outputRoot, 'feishu'))
  .map((file) => readFileSync(file, 'utf8')).join('\n');
for (const required of [
  'WSClient',
  'Remote Owner Product v1',
  'connectionScope',
  'check-abi',
  'better-sqlite3',
]) {
  if (!feishuBundle.includes(required)) fail(`Feishu artifact lost ${required}`);
}
for (const forbidden of [
  'createServerCoreController',
  'createLocalWorkerController',
  '/usr/bin/podman',
]) {
  if (feishuBundle.includes(forbidden)) fail(`Feishu artifact contains ${forbidden}`);
}
if (/(?:from|import\()\s*['"]electron(?:['"/])/.test(feishuBundle)) {
  fail('Feishu artifact imports Electron');
}
const allowedFeishuExternals = new Set([
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);
for (const match of feishuBundle.matchAll(/^import .* from "([^"]+)";/gm)) {
  if (!allowedFeishuExternals.has(match[1])) {
    fail(`Feishu artifact has an unpackaged external import: ${match[1]}`);
  }
}
const fullHostBridge = readFileSync(
  resolve(outputRoot, 'server-core-host-bridge/index.mjs'),
  'utf8',
);
for (const required of ['/usr/bin/podman', 'bridge-internal', 'io.agent-deck.instance']) {
  if (!fullHostBridge.includes(required)) fail(`Full host bridge lost ${required}`);
}
for (const forbidden of ['better-sqlite3', 'createServerCoreController', 'SessionConsoleDaemonRuntime']) {
  if (fullHostBridge.includes(forbidden)) fail(`Full host bridge contains ${forbidden}`);
}

const checks = [
  ['server-core', 'deploy/linux/full/server-core.config.example.json'],
  ['relay', 'deploy/linux/relay/relay.config.example.json'],
  ['local-worker', 'deploy/linux/relay/local-worker.config.example.json'],
];
for (const [role, fixture] of checks) {
  run(process.execPath, [
    resolve(outputRoot, role, 'index.mjs'),
    'check-config',
    '--config',
    resolve(repoRoot, fixture),
  ]);
}
run(process.execPath, [
  resolve(outputRoot, 'relay/index.mjs'),
  'check-authority',
  '--instance',
  'instance-a',
  '--authority',
  resolve(repoRoot, 'deploy/linux/relay/relay-authority.example.json'),
]);
for (const fixture of [
  'rootless-podman.config.example.json',
  'rootless-podman-full.config.example.json',
  'colima.config.example.json',
]) {
  run(process.execPath, [
    resolve(outputRoot, 'provider-session-supervisor/index.mjs'),
    'check-config',
    '--config',
    resolve(repoRoot, 'deploy/linux/provider-session', fixture),
  ]);
}
const fullProviderPaths = JSON.parse(runOutput(process.execPath, [
  resolve(outputRoot, 'provider-session-supervisor/index.mjs'),
  'runtime-paths',
  '--instance', 'instance-a',
  '--runtime-parent',
  '/var/lib/agent-deck/.local/share/containers/storage/volumes/' +
    'agent-deck-instance-a-socket/_data',
  '--uid', '1001',
]));
if (!fullProviderPaths.privateRoot.endsWith('/.provider-69856ec0faae6daf') ||
    Buffer.byteLength(fullProviderPaths.supervisorSocketPath) <= 103) {
  fail('Full Provider runtime-path derivation lost descriptor-bound long-path support');
}
const credentialFixture = JSON.parse(readFileSync(
  resolve(repoRoot, 'deploy/linux/full/server-core.credentials.example.json'),
  'utf8',
));
if (
  credentialFixture.schemaVersion !== 3 ||
  credentialFixture.instanceId !== 'instance-a' ||
  JSON.stringify(credentialFixture.credentials) !== JSON.stringify([
    {
      credentialId: 'desktop-credential-a', surface: 'desktop',
      publicKey: 'ssh-ed25519 AAAATEST desktop-credential-a',
      fingerprint: 'SHA256:desktop-credential-a', status: 'active',
      createdAt: 1, revokedAt: null,
    },
    {
      credentialId: 'feishu-credential-a', surface: 'feishu',
      publicKey: 'ssh-ed25519 AAAATEST feishu-credential-a',
      fingerprint: 'SHA256:feishu-credential-a', status: 'active',
      createdAt: 1, revokedAt: null,
    },
  ])
) fail('Server Core credential fixture drifted from the live lifecycle contract');
await verifyRelayBundleForcedCommands();
const feishuCheckRoot = realpathSync(mkdtempSync(
  resolve(realpathSync(tmpdir()), 'agent-deck-feishu-check-'),
));
try {
  const gatewayConfig = resolve(feishuCheckRoot, 'gateway.json');
  const coreConfig = resolve(feishuCheckRoot, 'core-ssh.json');
  copyFileSync(resolve(repoRoot, 'deploy/linux/feishu/config.example.json'), gatewayConfig);
  copyFileSync(resolve(repoRoot, 'deploy/linux/feishu/core-ssh.example.json'), coreConfig);
  chmodSync(gatewayConfig, 0o600);
  chmodSync(coreConfig, 0o600);
  run(process.execPath, [
    resolve(outputRoot, 'feishu/index.mjs'),
    'check-config',
    '--config', gatewayConfig,
    '--core-ssh-config', coreConfig,
  ]);
} finally {
  rmSync(feishuCheckRoot, { recursive: true, force: true });
}
await import(pathToFileURL(resolve(outputRoot, 'instance-manager/index.mjs')).href);
await import(pathToFileURL(resolve(outputRoot, 'server-control/index.mjs')).href);
if (!runOutput(process.execPath, [
  resolve(outputRoot, 'server-control/index.mjs'), '--help',
]).includes('Agent Deck Server 连接管理')) {
  fail('Server control bundle help output is incomplete');
}

for (const wrapper of [
  'agent-deckd',
  'agent-deck-full-bridge',
  'agent-deck-relay',
  'agent-deck-server',
  'agent-deck-instance-manager',
  'agent-deck-worker',
  'agent-deck-provider-supervisor',
  'provider-session',
  'agent-deck-feishu',
]) {
  const path = resolve(repoRoot, 'resources/bin', wrapper);
  run('/bin/bash', ['-n', path]);
  const source = readFileSync(path, 'utf8');
  const executionFence = wrapper === 'agent-deck-worker'
    ? source.includes('node=/usr/bin/node') &&
      source.includes('entrypoint=/opt/agent-deck/linux-headless/local-worker/index.mjs') &&
      source.includes('runtime_module=/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs') &&
      source.includes('verify_root_owned_linux /usr/bin/bwrap file') &&
      source.includes('com.agentdeck.worker-sandbox') &&
      source.includes('agent-deck-worker-bookmark') &&
      source.includes('Agent Deck Worker Node')
    : wrapper === 'agent-deck-feishu'
      ? source.includes('/opt/agent-deck/feishu-runtime/active') &&
        source.includes('/opt/agent-deck/feishu-runtime/releases/$runtime_digest') &&
        source.includes('/usr/bin/sha256sum --check --strict SHA256SUMS') &&
        source.includes('"$runtime_root/bin/node" "$runtime_root/app/index.mjs"')
    : wrapper === 'provider-session'
      ? source.includes('/usr/local/bin/node /opt/agent-deck/linux-headless/provider-session/')
      : wrapper === 'agent-deck-provider-supervisor'
        ? source.includes('/usr/bin/node /opt/agent-deck/linux-headless/provider-session-supervisor/') &&
          source.includes('Agent Deck Worker Node') &&
          source.includes('linux-headless/provider-session-supervisor/index.mjs')
      : source.includes('/usr/bin/node /opt/agent-deck/linux-headless/');
  if (
    !source.startsWith('#!/bin/bash -p\n') ||
    !source.includes('unset AGENT_DECK_HEADLESS_ROOT AGENT_DECK_NODE BASH_ENV ENV') ||
    !source.includes('exec /usr/bin/env -i') ||
    !executionFence ||
    /\$\{?AGENT_DECK_(?:HEADLESS_ROOT|NODE)|command -v/.test(source)
  ) fail(`${wrapper} does not use the canonical production runtime fence`);
}
const serverCoreWrapper = readFileSync(
  resolve(repoRoot, 'resources/bin/agent-deckd'),
  'utf8',
);
for (const required of [
  '/opt/agent-deck/linux-headless/server-core-runtime/index.mjs',
  '/opt/agent-deck/providers/claude/claude',
  '/opt/agent-deck/providers/codex/codex',
  '/opt/agent-deck/providers/grok/grok',
]) {
  if (!serverCoreWrapper.includes(required)) {
    fail(`Server Core wrapper does not fence ${required}`);
  }
}
const fullClientKey = readFileSync(
  resolve(repoRoot, 'deploy/linux/full/authorized-client-key-options.txt'),
  'utf8',
);
if (!fullClientKey.includes(
  'command="/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface desktop"',
)) fail('Server Core host bridge forced-command binding fixture is incomplete');
if (!fullClientKey.includes(
  'command="/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface feishu"',
)) fail('Server Core Feishu forced-command binding fixture is incomplete');
if (fullClientKey.includes('/run/agent-deck/')) {
  fail('Server Core forced command must not assume the named-volume socket is a host path');
}
process.stdout.write('Linux 无界面静态与打包检查已通过。\n');
