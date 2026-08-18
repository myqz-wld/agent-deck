import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FEISHU_RUNTIME_ARCHITECTURES,
  runtimeArtifactNames,
  validateRuntimeDescriptor,
} from './build-feishu-runtime.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(repoRoot, 'build/linux-headless');
const requireFromHere = createRequire(import.meta.url);

export const LINUX_HEADLESS_SOURCE_ROOTS = Object.freeze([
  'src/composition', 'src/clients/ssh', 'src/gateways/im', 'src/gateways/feishu',
  'src/hosts/daemon', 'src/hosts/server-core', 'src/hosts/server-control',
  'src/hosts/local-worker', 'src/hosts/provider-session', 'src/hosts/relay',
  'src/hosts/instance-manager', 'src/hosts/linux-runtime', 'src/hosts/feishu',
  'src/hosts/workspace-sandbox',
]);

export function fail(message) {
  process.stderr.write(`Linux 无界面检查失败：${message}\n`);
  process.exit(1);
}

export function filesUnder(root) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(root, entry.name);
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
  });
}

export function run(executable, args) {
  execFileSync(executable, args, {
    cwd: repoRoot,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runOutput(executable, args) {
  return execFileSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function verifyServerCoreRuntimeBundleLoads() {
  const root = realpathSync(mkdtempSync(
    resolve(realpathSync(tmpdir()), 'agent-deck-server-core-runtime-check-'),
  ));
  try {
    const runtimeUrl = pathToFileURL(resolve(outputRoot, 'server-core-runtime/index.mjs')).href;
    const workerRuntimeUrl = pathToFileURL(resolve(outputRoot, 'local-worker-runtime/index.mjs')).href;
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

export async function verifyRelayBundleForcedCommands() {
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
    const [workerAdmission, desktopAdmission, feishuAdmission] = admissions;
    const expectedWorkerAdmission = {
      version: 2,
      topology: 'relay',
      role: 'worker',
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      workerId: 'worker-a',
    };
    const clientAdmissionMatches = (admission, surface) =>
      admission?.version === 2 && admission.topology === 'relay' &&
      admission.role === 'client' && admission.instanceId === 'instance-a' &&
      admission.credentialId === 'credential-a' && admission.surface === surface &&
      typeof admission.connectionScope === 'string' &&
      admission.connectionScope.startsWith('scope-') &&
      admission.connectionScope !== admission.credentialId;
    if (
      admissions.length !== 3 ||
      JSON.stringify(workerAdmission) !== JSON.stringify(expectedWorkerAdmission) ||
      !clientAdmissionMatches(desktopAdmission, 'desktop') ||
      !clientAdmissionMatches(feishuAdmission, 'feishu') ||
      desktopAdmission.connectionScope !== feishuAdmission.connectionScope
    ) fail('Relay bundle admission handshake drifted from the packaged key fixtures');
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
}

export function verifyIssuedConnectionBundles() {
  const root = realpathSync(mkdtempSync(
    resolve(realpathSync(tmpdir()), 'agent-deck-connection-issue-'),
  ));
  const hostKey = resolve(root, 'ssh_host_ed25519_key.pub');
  const authorizedKeys = resolve(root, 'authorized_keys');
  try {
    writeFileSync(hostKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n', { mode: 0o644 });
    writeFileSync(authorizedKeys, '', { mode: 0o600 });
    const relayAuthority = resolve(root, 'relay-authority.json');
    const relayWorkerOutput = resolve(root, 'relay-worker.agentdeck-connection');
    writeFileSync(relayAuthority, `${JSON.stringify({
      schemaVersion: 1, instanceId: 'instance-a', credentials: [],
    })}\n`, { mode: 0o600 });
    run(process.execPath, [
      resolve(outputRoot, 'relay/index.mjs'), 'issue-worker-connection',
      '--instance', 'instance-a', '--credential', 'worker-credential-a',
      '--worker', 'worker-a', '--label', 'Relay production',
      '--hostname', 'relay.example.test', '--port', '22', '--username', 'agentdeck',
      '--host-key', hostKey, '--authority', relayAuthority, '--authorized-keys', authorizedKeys,
      '--runtime-uid', '1001', '--output', relayWorkerOutput,
    ]);
    const relayWorker = JSON.parse(readFileSync(relayWorkerOutput, 'utf8'));
    if (relayWorker.schemaVersion !== 3 || relayWorker.purpose !== 'worker' ||
        relayWorker.topology !== 'relay' || relayWorker.workerId !== 'worker-a' ||
        relayWorker.credentialId !== 'worker-credential-a' ||
        !String(relayWorker.identity?.privateKey).includes('OPENSSH PRIVATE KEY') ||
        (statSync(relayWorkerOutput).mode & 0o777) !== 0o600 ||
        !readFileSync(relayAuthority, 'utf8').includes('"kind": "relay-worker"') ||
        !readFileSync(authorizedKeys, 'utf8').includes('/run/user/1001/') ||
        !readFileSync(authorizedKeys, 'utf8').includes('--worker worker-a')) {
      fail('Relay bundle did not issue one exact Worker credential');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function validateCurrentLinuxPackageManifests(packageFixture, builtManifest) {
  if (packageFixture.schemaVersion !== 1 || builtManifest.schemaVersion !== 1) {
    throw new Error('Linux package manifests must use the current schemaVersion 1');
  }
  if (JSON.stringify(Object.keys(packageFixture).sort()) !== JSON.stringify([
    'entries', 'forcedCommandSshdPolicy', 'hostRequirements', 'installMapping',
    'instanceManagerKind', 'nativeExternals', 'relayArtifactMustExclude', 'runtime',
    'schemaVersion', 'serverControlKind', 'target',
  ])) {
    throw new Error('Linux package manifest contains missing or non-current fields');
  }
  if (JSON.stringify(Object.keys(builtManifest).sort()) !== JSON.stringify([
    'entries', 'nativeExternals', 'runtime', 'schemaVersion', 'target',
  ])) {
    throw new Error('built Linux manifest contains missing or non-current fields');
  }
  if (
    packageFixture.runtime !== 'node' || builtManifest.runtime !== 'node' ||
    packageFixture.target !== 'node22' || builtManifest.target !== 'node22'
  ) {
    throw new Error('Linux package manifests must use the current Node 22 runtime');
  }
}

export function verifyLinuxPackageAndRuntimeArtifacts() {
  const packageFixture = JSON.parse(readFileSync(
    resolve(repoRoot, 'deploy/linux/manager/linux-headless.package.json'),
    'utf8',
  ));
  const builtManifest = JSON.parse(readFileSync(resolve(outputRoot, 'manifest.json'), 'utf8'));
  try {
    validateCurrentLinuxPackageManifests(packageFixture, builtManifest);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Linux package manifest is invalid');
  }
  if (JSON.stringify(packageFixture.entries) !== JSON.stringify(builtManifest.entries)) {
    fail('built entries differ from the package fixture');
  }
  if (
    packageFixture.instanceManagerKind !== 'host-only-command' ||
    packageFixture.serverControlKind !== 'root-only-command' ||
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
    packageFixture.hostRequirements?.fullStateConfigTransport !== 'exact-rootless-volume-data-path' ||
    packageFixture.hostRequirements?.fullStateConfigDigestBound !== true
  ) fail('instance-manager host-only requirements are incomplete');
  const install = packageFixture.installMapping;
  if (
    install?.serverCoreBundle !== '/opt/agent-deck/linux-headless/server-core/index.mjs' ||
    install?.serverCoreRuntimeBundle !== '/opt/agent-deck/linux-headless/server-core-runtime/index.mjs' ||
    install?.serverCoreContainerCommand !== '/opt/agent-deck/bin/agent-deckd' ||
    install?.serverCoreHostBridgeBundle !== '/opt/agent-deck/linux-headless/server-core-host-bridge/index.mjs' ||
    install?.serverCoreHostForcedCommand !== '/opt/agent-deck/bin/agent-deck-full-bridge' ||
    install?.serverControlBundle !== '/opt/agent-deck/linux-headless/server-control/index.mjs' ||
    install?.serverControlCommand !== '/opt/agent-deck/bin/agent-deck-server' ||
    install?.relayCommand !== '/opt/agent-deck/bin/agent-deck-relay' ||
    install?.relayHealthGateCommand !== '/opt/agent-deck/bin/agent-deck-relay-health-gate' ||
    install?.instanceManagerBundle !== '/opt/agent-deck/linux-headless/instance-manager/index.mjs' ||
    install?.instanceManagerCommand !== '/opt/agent-deck/bin/agent-deck-instance-manager' ||
    install?.localWorkerCommand !== '/opt/agent-deck/bin/agent-deck-worker' ||
    install?.localWorkerRuntimeBundle !== '/opt/agent-deck/linux-headless/local-worker-runtime/index.mjs' ||
    install?.providerSessionBundle !== '/opt/agent-deck/linux-headless/provider-session/index.mjs' ||
    install?.providerSessionCommand !== '/opt/agent-deck/bin/provider-session' ||
    install?.providerSessionSupervisorBundle !== '/opt/agent-deck/linux-headless/provider-session-supervisor/index.mjs' ||
    install?.providerSessionSupervisorCommand !== '/opt/agent-deck/bin/agent-deck-provider-supervisor' ||
    install?.browserCliCommand !== '/opt/agent-deck/bin/agent-deck-browser.cjs' ||
    install?.providerSessionSupervisorServiceTemplate !== '/opt/agent-deck/share/provider-session/agent-deck-provider-supervisor.service.in' ||
    install?.providerSessionSupervisorDarwinTemplate !== 'Agent Deck.app/Contents/Resources/provider-session/com.agentdeck.provider-supervisor.plist.in' ||
    install?.feishuCommand !== '/opt/agent-deck/bin/agent-deck-feishu' ||
    install?.feishuPreflight !== '/opt/agent-deck/libexec/agent-deck-feishu-preflight' ||
    install?.feishuRuntimeRoot !== '/opt/agent-deck/feishu-runtime' ||
    install?.feishuRuntimePointer !== '/opt/agent-deck/feishu-runtime/active' ||
    install?.feishuRuntimeDesiredPointer !== '/opt/agent-deck/feishu-runtime/desired' ||
    install?.feishuRuntimeReleasePattern !== '/opt/agent-deck/feishu-runtime/releases/<sha256>' ||
    JSON.stringify(install?.feishuRuntimeArchitectures) !== JSON.stringify(['amd64', 'arm64']) ||
    install?.feishuRuntimeNodeVersion !== '22.22.3' || install?.feishuRuntimeNodeAbi !== 127 ||
    install?.feishuRuntimeBetterSqlite3Version !== '11.10.0' ||
    install?.feishuServiceUnit !== '/etc/systemd/system/agent-deck-feishu.service' ||
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
  for (const architecture of FEISHU_RUNTIME_ARCHITECTURES) {
    const names = runtimeArtifactNames(architecture);
    const directory = resolve(repoRoot, 'build/feishu-runtime', `linux-${architecture}`);
    const descriptor = validateRuntimeDescriptor(JSON.parse(
      readFileSync(resolve(directory, names.descriptor), 'utf8'),
    ), architecture);
    const artifact = resolve(directory, names.artifact);
    if (statSync(artifact).size !== descriptor.size) {
      fail(`Feishu ${architecture} runtime size differs from its descriptor`);
    }
    const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    if (digest !== descriptor.sha256) {
      fail(`Feishu ${architecture} runtime digest differs from its descriptor`);
    }
    if (readFileSync(resolve(directory, names.checksum), 'utf8') !==
        `${descriptor.sha256}  ${names.artifact}\n`) {
      fail(`Feishu ${architecture} runtime checksum file is invalid`);
    }
  }
  return { packageFixture, builtManifest };
}
