#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { builtinModules, createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(repoRoot, 'build/linux-headless');
const requireFromHere = createRequire(import.meta.url);
const sourceRoots = [
  'src/composition',
  'src/clients/ssh',
  'src/gateways/im',
  'src/gateways/feishu',
  'src/hosts/daemon',
  'src/hosts/server-core',
  'src/hosts/local-worker',
  'src/hosts/provider-session',
  'src/hosts/relay',
  'src/hosts/instance-manager',
  'src/hosts/linux-runtime',
  'src/hosts/feishu',
  'src/hosts/workspace-sandbox',
];

function fail(message) {
  process.stderr.write(`Linux 无界面检查失败：${message}\n`);
  process.exit(1);
}

function filesUnder(root) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function run(executable, args) {
  execFileSync(executable, args, {
    cwd: repoRoot,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runOutput(executable, args) {
  return execFileSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyServerCoreRuntimeBundleLoads() {
  const root = realpathSync(mkdtempSync(
    resolve(realpathSync(tmpdir()), 'agent-deck-server-core-runtime-check-'),
  ));
  try {
    const runtimeUrl = pathToFileURL(
      resolve(outputRoot, 'server-core-runtime/index.mjs'),
    ).href;
    const workerRuntimeUrl = pathToFileURL(
      resolve(outputRoot, 'local-worker-runtime/index.mjs'),
    ).href;
    const source = `
      const runtimeModule = await import(${JSON.stringify(runtimeUrl)});
      if (typeof runtimeModule.createServerCoreRuntime !== 'function') process.exit(2);
      const workerRuntimeModule = await import(${JSON.stringify(workerRuntimeUrl)});
      if (typeof workerRuntimeModule.createLocalWorkerRuntime !== 'function') process.exit(4);
      const root = ${JSON.stringify(root)};
      const paths = {
        instanceId: 'instance-a',
        stateDirectory: root + '/state',
        configurationDirectory: root + '/config',
        logDirectory: root + '/state/logs',
        runtimeDirectory: root + '/run',
        socketPath: root + '/run/agent-deckd.sock',
      };
      const bootstrap = runtimeModule.createServerCoreRuntime({
        instanceId: 'instance-a',
        appVersion: '1.0.0',
        paths,
        runtimeOptions: { providerSettings: {}, projects: [] },
      });
      if (!bootstrap.processId || !bootstrap.runtime ||
          !bootstrap.sessionConsoleAuthority || !bootstrap.credentialLifecycle) process.exit(3);
    `;
    execFileSync(requireFromHere('electron'), ['--input-type=module', '--eval', source], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function relayFixtureCommands() {
  const relayRoot = resolve(repoRoot, 'deploy/linux/relay');
  const sources = [
    readFileSync(resolve(relayRoot, 'authorized-key-options.txt'), 'utf8'),
    readFileSync(resolve(relayRoot, 'authorized-client-key-options.txt'), 'utf8'),
  ];
  const commands = sources.flatMap((source) => [...source.matchAll(/command="([^"]+)"/g)])
    .map((match) => match[1]
      .replaceAll('INSTANCE_ID', 'instance-a')
      .replaceAll('CREDENTIAL_ID', 'credential-a')
      .replaceAll('WORKER_ID', 'worker-a')
      .replaceAll('RUNTIME_UID', '1001'));
  if (commands.length !== 3) fail('Relay authorized-key fixtures are incomplete');
  return commands;
}

async function verifyRelayBundleForcedCommands() {
  const root = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'agent-deck-relay-wire-')));
  const socketPath = resolve(root, 'control.sock');
  const admissions = [];
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const declared = buffered.readUInt32BE(0);
      if (declared <= 0 || declared > 8 * 1024 || buffered.byteLength < declared + 4) return;
      admissions.push(JSON.parse(buffered.subarray(4, declared + 4).toString('utf8')));
      socket.end();
    });
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolveListen);
    });
    const relay = await import(pathToFileURL(resolve(outputRoot, 'relay/index.mjs')).href);
    if (await relay.runRelayEntrypoint(['health', '--socket', socketPath]) !== 0) {
      fail('Relay bundle health command rejected its private control socket');
    }
    for (const [index, command] of relayFixtureCommands().entries()) {
      const [, ...argv] = command.split(' ');
      const originalCommand = index === 0
        ? 'agent-deck-relay attach --instance instance-a --credential credential-a --worker worker-a'
        : 'agent-deck-bridge';
      const accepted = await relay.runRelayForcedCommand(argv, {
        serviceUid: 1001,
        originalCommand,
        input: Readable.from([]),
        output: new PassThrough(),
        connect: (declaredPath) => new Promise((resolveSocket, reject) => {
          if (declaredPath !== '/run/user/1001/agent-deck-relay/instance-a/control.sock') {
            reject(new Error('Relay binding produced an unexpected control socket'));
            return;
          }
          const socket = createConnection(socketPath);
          socket.once('connect', () => resolveSocket(socket));
          socket.once('error', reject);
        }),
      });
      if (accepted !== true) fail('Relay bundle rejected a packaged forced command');
    }
    if (JSON.stringify(admissions) !== JSON.stringify([
      { version: 1, topology: 'relay', role: 'worker', instanceId: 'instance-a', credentialId: 'credential-a', workerId: 'worker-a' },
      { version: 1, topology: 'relay', role: 'client', instanceId: 'instance-a', credentialId: 'credential-a', surface: 'desktop-full' },
      { version: 1, topology: 'relay', role: 'client', instanceId: 'instance-a', credentialId: 'credential-a', surface: 'feishu-session-console' },
    ])) fail('Relay bundle admission handshake drifted from the packaged key fixtures');
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
}

function verifyIssuedConnectionBundles() {
  const root = realpathSync(mkdtempSync(
    resolve(realpathSync(tmpdir()), 'agent-deck-connection-issue-'),
  ));
  const hostKey = resolve(root, 'ssh_host_ed25519_key.pub');
  const authorizedKeys = resolve(root, 'authorized_keys');
  try {
    writeFileSync(hostKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n', { mode: 0o644 });
    writeFileSync(authorizedKeys, '', { mode: 0o600 });
    const fullAuthority = resolve(root, 'full-credentials.json');
    const fullOutput = resolve(root, 'full.agentdeck-connection');
    writeFileSync(fullAuthority, `${JSON.stringify({
      schemaVersion: 1, instanceId: 'instance-a', credentials: [],
    })}\n`, { mode: 0o600 });
    run(process.execPath, [
      resolve(outputRoot, 'server-core/index.mjs'), 'issue-connection',
      '--instance', 'instance-a', '--credential', 'desktop-full-a',
      '--label', 'Full production', '--hostname', 'full.example.test',
      '--port', '22', '--username', 'agentdeck', '--host-key', hostKey,
      '--credential-file', fullAuthority, '--authorized-keys', authorizedKeys,
      '--output', fullOutput,
    ]);
    const full = JSON.parse(readFileSync(fullOutput, 'utf8'));
    if (full.kind !== 'agent-deck-remote-connection-credential' ||
        full.topology !== 'server-core' || full.instanceId !== 'instance-a' ||
        !String(full.identity?.privateKey).includes('OPENSSH PRIVATE KEY') ||
        (statSync(fullOutput).mode & 0o777) !== 0o600) {
      fail('Server Core bundle did not issue one exact private connection credential');
    }
    if (!readFileSync(fullAuthority, 'utf8').includes('desktop-full-a') ||
        !readFileSync(authorizedKeys, 'utf8').includes('--surface desktop-full')) {
      fail('Server Core issuance did not enroll the matching credential and forced key');
    }

    writeFileSync(authorizedKeys, '', { mode: 0o600 });
    const relayConfig = resolve(root, 'relay-config.json');
    const relayClientOutput = resolve(root, 'relay-client.agentdeck-connection');
    const relayWorkerOutput = resolve(root, 'relay-worker.agentdeck-connection');
    writeFileSync(relayConfig, `${JSON.stringify({
      schemaVersion: 1, instanceId: 'instance-a', tickIntervalMs: 1000,
      plumbingModule: null, credentials: [],
    })}\n`, { mode: 0o600 });
    run(process.execPath, [
      resolve(outputRoot, 'relay/index.mjs'), 'issue-worker-connection',
      '--instance', 'instance-a', '--credential', 'worker-credential-a',
      '--worker', 'worker-a',
      '--label', 'Relay production', '--hostname', 'relay.example.test',
      '--port', '22', '--username', 'agentdeck', '--host-key', hostKey,
      '--config', relayConfig, '--authorized-keys', authorizedKeys,
      '--runtime-uid', '1001', '--output', relayWorkerOutput,
    ]);
    run(process.execPath, [
      resolve(outputRoot, 'relay/index.mjs'), 'issue-client-connection',
      '--instance', 'instance-a', '--credential', 'desktop-relay-a',
      '--label', 'Relay production', '--hostname', 'relay.example.test',
      '--port', '22', '--username', 'agentdeck', '--host-key', hostKey,
      '--config', relayConfig, '--authorized-keys', authorizedKeys,
      '--runtime-uid', '1001', '--output', relayClientOutput,
    ]);
    const relayWorker = JSON.parse(readFileSync(relayWorkerOutput, 'utf8'));
    const relayClient = JSON.parse(readFileSync(relayClientOutput, 'utf8'));
    if (relayWorker.schemaVersion !== 2 || relayWorker.purpose !== 'worker' ||
        relayWorker.topology !== 'relay' || relayWorker.workerId !== 'worker-a' ||
        relayWorker.credentialId !== 'worker-credential-a' ||
        !String(relayWorker.identity?.privateKey).includes('OPENSSH PRIVATE KEY') ||
        relayClient.schemaVersion !== 2 || relayClient.purpose !== 'client' ||
        relayClient.topology !== 'relay' || relayClient.credentialId !== 'desktop-relay-a' ||
        relayClient.workerId !== undefined ||
        !String(relayClient.identity?.privateKey).includes('OPENSSH PRIVATE KEY') ||
        (statSync(relayWorkerOutput).mode & 0o777) !== 0o600 ||
        (statSync(relayClientOutput).mode & 0o777) !== 0o600 ||
        !readFileSync(relayConfig, 'utf8').includes('"kind": "ssh-client"') ||
        !readFileSync(relayConfig, 'utf8').includes('"kind": "relay-worker"') ||
        !readFileSync(authorizedKeys, 'utf8').includes('/run/user/1001/') ||
        !readFileSync(authorizedKeys, 'utf8').includes('--surface desktop-full') ||
        !readFileSync(authorizedKeys, 'utf8').includes('--worker worker-a')) {
      fail('Relay bundle did not separately issue exact Client and Worker credentials');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const root of sourceRoots) {
  for (const file of filesUnder(resolve(repoRoot, root))) {
    if (!['.ts', '.tsx'].includes(extname(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n').length - 1;
    if (lines >= 500) fail(`${relative(repoRoot, file)} has ${lines} lines`);
    if (!file.endsWith('.test.ts') && /(?:from|import\()\s*['"]electron(?:['"/])/.test(readFileSync(file, 'utf8'))) {
      fail(`${relative(repoRoot, file)} imports Electron`);
    }
  }
}

const packageFixture = JSON.parse(readFileSync(
  resolve(repoRoot, 'deploy/linux/manager/linux-headless.package.json'),
  'utf8',
));
const builtManifest = JSON.parse(readFileSync(resolve(outputRoot, 'manifest.json'), 'utf8'));
if (JSON.stringify(packageFixture.entries) !== JSON.stringify(builtManifest.entries)) {
  fail('built entries differ from the package fixture');
}
if (
  packageFixture.instanceManagerKind !== 'host-only-library' ||
  packageFixture.hostRequirements?.platform !== 'linux' ||
  packageFixture.hostRequirements?.procSelfFd !== true ||
  packageFixture.hostRequirements?.podman !== 'rootless' ||
  packageFixture.hostRequirements?.nodeExecutable !== '/usr/bin/node' ||
  packageFixture.hostRequirements?.podmanExecutable !== '/usr/bin/podman' ||
  packageFixture.hostRequirements?.workspaceSandboxExecutable !== '/usr/bin/bwrap' ||
  packageFixture.hostRequirements?.providerSupervisorLifecycle !== 'systemd-user-or-launchd' ||
  packageFixture.hostRequirements?.providerSupervisorConfigMode !== '0600' ||
  packageFixture.hostRequirements?.providerSupervisorRuntimeMode !== '0700' ||
  packageFixture.hostRequirements?.wrapperShell !== '/bin/bash' ||
  packageFixture.hostRequirements?.emptyEnvironmentExecutable !== '/usr/bin/env' ||
  packageFixture.hostRequirements?.serviceAccountHome !== '/var/lib/agent-deck' ||
  packageFixture.hostRequirements?.fullStateConfigProvisioning !==
    '/var/lib/agent-deck/config/agent-deck/instances/<instanceId>/config.json' ||
  packageFixture.hostRequirements?.fullStateConfigOwner !== 'instance-manager' ||
  packageFixture.hostRequirements?.fullStateConfigTransport !==
    'exact-rootless-volume-data-path' ||
  packageFixture.hostRequirements?.fullStateConfigDigestBound !== true
) fail('instance-manager host-only requirements are incomplete');
const install = packageFixture.installMapping;
if (
  install?.serverCoreBundle !== '/opt/agent-deck/linux-headless/server-core/index.mjs' ||
  install?.serverCoreRuntimeBundle !==
    '/opt/agent-deck/linux-headless/server-core-runtime/index.mjs' ||
  install?.serverCoreContainerCommand !== '/opt/agent-deck/bin/agent-deckd' ||
  install?.serverCoreHostBridgeBundle !==
    '/opt/agent-deck/linux-headless/server-core-host-bridge/index.mjs' ||
  install?.serverCoreHostForcedCommand !== '/opt/agent-deck/bin/agent-deck-full-bridge' ||
  install?.relayCommand !== '/opt/agent-deck/bin/agent-deck-relay' ||
  install?.localWorkerCommand !== '/opt/agent-deck/bin/agent-deck-worker' ||
  install?.localWorkerRuntimeBundle !==
    '/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs' ||
  install?.providerSessionBundle !==
    '/opt/agent-deck/linux-headless/provider-session/index.mjs' ||
  install?.providerSessionCommand !== '/opt/agent-deck/bin/provider-session' ||
  install?.providerSessionSupervisorBundle !==
    '/opt/agent-deck/linux-headless/provider-session-supervisor/index.mjs' ||
  install?.providerSessionSupervisorCommand !==
    '/opt/agent-deck/bin/agent-deck-provider-supervisor' ||
  install?.providerSessionSupervisorServiceTemplate !==
    '/opt/agent-deck/share/provider-session/agent-deck-provider-supervisor.service.in' ||
  install?.providerSessionSupervisorDarwinTemplate !==
    'Agent Deck.app/Contents/Resources/provider-session/com.agentdeck.provider-supervisor.plist.in' ||
  install?.feishuBundle !== '/opt/agent-deck/linux-headless/feishu/index.mjs' ||
  install?.feishuCommand !== '/opt/agent-deck/bin/agent-deck-feishu' ||
  install?.feishuPreflight !== '/opt/agent-deck/libexec/agent-deck-feishu-preflight' ||
  install?.claudeExecutable !== '/opt/agent-deck/providers/claude/claude' ||
  install?.codexExecutable !== '/opt/agent-deck/providers/codex/codex' ||
  install?.grokExecutable !== '/opt/agent-deck/providers/grok/grok' ||
  install?.ownership !== 'root:root' || install?.wrapperMode !== '0755' ||
  install?.bundleMode !== '0644' || install?.symlinksAllowed !== false
) fail('canonical Linux install mapping is incomplete');
const sshdPolicy = packageFixture.forcedCommandSshdPolicy;
if (
  sshdPolicy?.permitUserEnvironment !== false ||
  sshdPolicy?.authorizedKeyEnvironmentOptionAllowed !== false ||
  JSON.stringify(sshdPolicy?.forbiddenAcceptedEnvironment) !== JSON.stringify([
    'AGENT_DECK_HEADLESS_ROOT', 'AGENT_DECK_NODE', 'BASH_ENV', 'ENV',
    'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'PATH',
  ])
) fail('forced-command sshd environment policy is incomplete');
if (builtManifest.nativeExternals?.join(',') !== 'better-sqlite3') {
  fail('better-sqlite3 must remain an explicit Node-native external');
}

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
  'feishu-session-console',
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
  credentialFixture.schemaVersion !== 1 ||
  credentialFixture.instanceId !== 'instance-a' ||
  JSON.stringify(credentialFixture.credentials) !== JSON.stringify([
    { credentialId: 'desktop-credential-a', surface: 'desktop-full', status: 'active' },
    { credentialId: 'feishu-credential-a', surface: 'feishu-session-console', status: 'active' },
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

for (const wrapper of [
  'agent-deckd',
  'agent-deck-full-bridge',
  'agent-deck-relay',
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
  'command="/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface desktop-full"',
)) fail('Server Core host bridge forced-command binding fixture is incomplete');
if (!fullClientKey.includes(
  'command="/opt/agent-deck/bin/agent-deck-full-bridge --instance INSTANCE_ID --credential CREDENTIAL_ID --surface feishu-session-console"',
)) fail('Server Core Feishu forced-command binding fixture is incomplete');
if (fullClientKey.includes('/run/agent-deck/')) {
  fail('Server Core forced command must not assume the named-volume socket is a host path');
}
process.stdout.write('Linux 无界面静态与打包检查已通过。\n');
