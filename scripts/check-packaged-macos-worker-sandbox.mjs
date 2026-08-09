import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
  throw new Error('packaged macOS Worker sandbox verification requires macOS');
}

const ROOT = resolve(import.meta.dirname, '..');
const archDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const app = resolve(ROOT, 'build/dist', archDirectory, 'Agent Deck.app');
if (!existsSync(app)) {
  throw new Error(`packaged Agent Deck application is missing: ${app}`);
}

const contents = resolve(app, 'Contents');
const resources = resolve(contents, 'Resources');
const native = resolve(contents, 'MacOS');
const broker = resolve(native, 'agent-deck-worker-bookmark');
const launcher = resolve(native, 'agent-deck-worker-sandbox');
const workerCli = resolve(contents, 'MacOS/Agent Deck Worker CLI');
const workerNode = resolve(native, 'Agent Deck Worker Node');
const wrapper = resolve(resources, 'bin/agent-deck-worker');
const providerSupervisorWrapper = resolve(resources, 'bin/agent-deck-provider-supervisor');
const providerSupervisorBundle = resolve(
  resources,
  'linux-headless/provider-session-supervisor/index.mjs',
);
const providerProvisioningRoot = resolve(resources, 'provider-session');
const providers = resolve(contents, 'MacOS/Agent Deck Worker Providers');
const claudeExecutable = resolve(providers, 'claude/claude');
const codexExecutable = resolve(providers, 'codex/bin/codex');
const codexCodeModeHost = resolve(providers, 'codex/bin/codex-code-mode-host');
const codexRg = resolve(providers, 'codex/codex-path/rg');
const codexZsh = resolve(providers, 'codex/codex-resources/zsh/bin/zsh');
const grokExecutable = resolve(providers, 'grok/grok');
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-packaged-worker-workspace-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-packaged-worker-outside-')));
const containerParent = join(
  homedir(),
  'Library/Containers/com.agentdeck.worker-sandbox/Data/Library/Application Support/Agent Deck',
);
mkdirSync(containerParent, { recursive: true, mode: 0o700 });
const privateRoot = mkdtempSync(join(containerParent, 'packaged-check-'));
const bookmark = join(privateRoot, 'workspace.bookmark');
const runtimeModule = resolve(resources, 'linux-headless/local-worker-runtime/index.mjs');
const runtimeConfig = join(privateRoot, 'worker.json');
const providerProfile = join(privateRoot, 'provider.sb');
const workspaceCanary = join(workspace, 'inside.txt');
const workerScript = join(workspace, 'worker-canary.cjs');
const outsideCanary = join(outside, 'outside.txt');
const wrapperEnvironment = { ...process.env };
delete wrapperEnvironment.ELECTRON_RUN_AS_NODE;

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: workspace,
    encoding: 'utf8',
    ...options,
  });
}

function quoted(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function strictProviderProfile() {
  const roots = [workspace, contents, '/bin', '/usr/bin', '/usr/lib', '/System/Library'];
  const filters = roots.map((root) => `       (subpath ${quoted(root)})`).join('\n');
  return `(version 1)\n(deny default)\n(import "system.sb")\n` +
    `(allow process-fork)\n(allow process-exec\n${filters})\n` +
    `(allow signal (target same-sandbox))\n` +
    `(allow file-read-metadata file-test-existence)\n` +
    `(allow file-read* file-map-executable file-test-existence\n${filters})\n` +
    `(allow file-write* (subpath ${quoted(workspace)}))\n`;
}

try {
  for (const executable of [
    broker,
    launcher,
    workerCli,
    workerNode,
    claudeExecutable,
    codexExecutable,
    codexCodeModeHost,
    codexRg,
    codexZsh,
    grokExecutable,
  ]) {
    run('/usr/bin/codesign', ['--verify', '--strict', executable]);
  }
  writeFileSync(workspaceCanary, 'inside\n', { mode: 0o600 });
  writeFileSync(outsideCanary, 'outside\n', { mode: 0o600 });
  writeFileSync(workerScript, [
    "const { readFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "if (readFileSync(process.argv[2], 'utf8') !== 'inside\\n') process.exit(2);",
    "const provider = spawnSync(process.argv[4], ['--version'], { encoding: 'utf8' });",
    "if (provider.status !== 0 || !/codex/i.test(provider.stdout + provider.stderr)) process.exit(3);",
    "process.stdout.write('worker-runtime-ok');",
    '',
  ].join('\n'), { mode: 0o600 });
  run(broker, ['create', workspace, bookmark]);
  chmodSync(bookmark, 0o600);
  writeFileSync(providerProfile, strictProviderProfile(), { mode: 0o600 });
  const bootstrapBookmark = readFileSync(bookmark);

  const workerArgs = [
    '--bookmark', bookmark,
    '--workspace', workspace,
    '--', workerNode, workerScript, workspaceCanary, outsideCanary, codexExecutable,
  ];
  const workerEnvironment = {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
  const workerOutput = run(launcher, workerArgs, workerEnvironment).trim();
  if (workerOutput !== 'worker-runtime-ok') {
    throw new Error(`unexpected packaged Worker runtime output: ${workerOutput}`);
  }
  const persistentBookmark = readFileSync(bookmark);
  if (!bootstrapBookmark.equals(persistentBookmark)) {
    throw new Error('packaged launcher unexpectedly mutated the Workspace bookmark');
  }
  const persistentOutput = run(launcher, workerArgs, workerEnvironment).trim();
  if (persistentOutput !== workerOutput) {
    throw new Error(`packaged persistent bookmark output changed: ${persistentOutput}`);
  }

  const providerOutput = run(launcher, [
    '--bookmark', bookmark,
    '--workspace', workspace,
    '--', '/usr/bin/sandbox-exec', '-f', providerProfile,
    '/bin/cat', workspaceCanary,
  ]).trim();
  if (providerOutput !== 'inside') {
    throw new Error(`provider sandbox could not read Workspace: ${providerOutput}`);
  }
  let outsideDenied = false;
  try {
    run(launcher, [
      '--bookmark', bookmark,
      '--workspace', workspace,
      '--', '/usr/bin/sandbox-exec', '-f', providerProfile,
      '/bin/cat', outsideCanary,
    ]);
  } catch {
    outsideDenied = true;
  }
  if (!outsideDenied) throw new Error('provider sandbox read outside Workspace');

  const environment = {
    coreConfigRoot: join(privateRoot, 'core-config'),
    coreRuntimeRoot: join(privateRoot, 'core-runtime'),
    coreStateRoot: join(privateRoot, 'core-state'),
    providerCacheRoot: join(privateRoot, 'provider-cache'),
    providerHomeRoot: join(privateRoot, 'provider-home'),
    providerTempRoot: join(privateRoot, 'provider-tmp'),
  };
  for (const directory of Object.values(environment)) {
    mkdirSync(directory, { mode: 0o700 });
  }
  writeFileSync(runtimeConfig, `${JSON.stringify({
    schemaVersion: 2,
    instanceId: 'relay-smoke',
    appVersion: '0.1.0',
    runtimeModule,
    runtimeOptions: {},
    generationFile: join(privateRoot, 'generation.json'),
    ssh: {
      sshBinary: '/usr/bin/ssh',
      host: 'relay.example.invalid',
      port: 22,
      user: 'worker',
      identityFile: join(privateRoot, 'ssh/id_ed25519'),
      knownHostsFile: join(privateRoot, 'ssh/known_hosts'),
      instanceId: 'relay-smoke',
      workerId: 'worker-packaged-check',
      credentialId: 'credential-packaged-check',
      connectTimeoutSeconds: 15,
    },
    workspaceSandbox: {
      schemaVersion: 1,
      execution: 'relay-worker',
      workerConfigId: 'worker-packaged-check',
      workerId: 'worker-packaged-check',
      workspaceRoot: workspace,
      privateRoot,
      runtimeReadRoots: [contents],
      environment,
      networkBoundary: 'provider-controlled',
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const runtimeEnvironment = {
    HOME: environment.providerHomeRoot,
    XDG_CACHE_HOME: environment.providerCacheRoot,
    XDG_CONFIG_HOME: environment.providerHomeRoot,
    XDG_RUNTIME_DIR: environment.coreRuntimeRoot,
    XDG_STATE_HOME: environment.providerHomeRoot,
    TMPDIR: environment.providerTempRoot,
    TMP: environment.providerTempRoot,
    TEMP: environment.providerTempRoot,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
  };
  const runtimeOutput = run(launcher, [
    '--bookmark', bookmark,
    '--workspace', workspace,
    '--', wrapper, 'check-runtime', '--config', runtimeConfig,
  ], { env: runtimeEnvironment }).trim();
  if (runtimeOutput !== '') {
    throw new Error(`packaged runtime check produced output: ${runtimeOutput}`);
  }

  run(wrapper, ['check-abi'], {
    env: wrapperEnvironment,
  });
  for (const path of [
    providerSupervisorWrapper,
    providerSupervisorBundle,
    resolve(providerProvisioningRoot, 'com.agentdeck.provider-supervisor.plist.in'),
    resolve(providerProvisioningRoot, 'colima.config.example.json'),
  ]) {
    if (!existsSync(path)) throw new Error(`packaged Provider supervisor asset is missing: ${path}`);
  }
  const colimaExample = JSON.parse(readFileSync(
    resolve(providerProvisioningRoot, 'colima.config.example.json'),
    'utf8',
  ));
  if (colimaExample.executable === '/opt/homebrew/bin/docker') {
    throw new Error('packaged Colima example retained the rejected Homebrew symlink');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const providerPaths = JSON.parse(run(providerSupervisorWrapper, [
    'runtime-paths',
    '--instance', 'relay-smoke',
    '--runtime-parent', '/private/tmp',
    '--uid', String(uid),
    '--worker-config', 'worker-packaged-check',
  ], { env: wrapperEnvironment }));
  if (
    !new RegExp(`^/private/tmp/adp-${uid}-[a-f0-9]{16}$`).test(providerPaths.privateRoot) ||
    Buffer.byteLength(providerPaths.supervisorSocketPath) > 103
  ) {
    throw new Error('packaged Provider supervisor derived an invalid macOS socket namespace');
  }
  run(providerSupervisorWrapper, [
    'check-config',
    '--config', resolve(providerProvisioningRoot, 'colima.config.example.json'),
  ], { env: wrapperEnvironment });
  process.stdout.write('[macos-worker-sandbox] packaged Worker runtime passed\n');
} finally {
  rmSync(privateRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
