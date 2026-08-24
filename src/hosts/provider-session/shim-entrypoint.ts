import {
  lstat,
  mkdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { SessionConsoleSandboxAccess } from '@contracts/index';

import { ProviderSessionShimInferenceProxy } from './shim-inference-proxy';
import { ProviderSessionMultiplexConnection } from './multiplex';
import type { ProviderSessionInferenceTransport } from './types';
import {
  prepareProviderSessionBrowserRuntime,
  type ProviderSessionBrowserRuntimeHandle,
} from './browser-runtime';

const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_STATE = '/state';
const CONTAINER_HOME = '/state/home';
const CONTAINER_BROKER = '/run/agent-deck/inference.sock';
const GROK_BINARY = '/opt/agent-deck/providers/grok/grok';
const BROKER_MARKER = 'agent-deck-session-broker';
const GROK_UPSTREAM_PATHS = Object.freeze(['/v1/chat/completions', '/v1/responses']);

export interface ProviderSessionShimArgs {
  readonly access: SessionConsoleSandboxAccess;
  readonly adapter: 'grok-build';
  readonly projectTrusted: boolean;
}

export interface ProviderSessionShimLaunchSpec {
  readonly args: readonly string[];
  readonly binary: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ProviderSessionShimDependencies {
  readonly brokerSocketPath?: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly grokBinary?: string;
  readonly spawnProcess?: typeof spawn;
  readonly transportStream?: Duplex;
}

const ACCESS = new Set<SessionConsoleSandboxAccess>([
  'provider-strict',
  'selected-directory-read-write',
  'workspace-read-only',
  'workspace-read-write',
]);

function sandbox(access: SessionConsoleSandboxAccess, nativeSandbox: boolean): string {
  if (!nativeSandbox) return 'off';
  if (access === 'provider-strict') return 'strict';
  if (access === 'selected-directory-read-write') return 'workspace';
  if (access === 'workspace-read-only') return 'read-only';
  return 'off';
}

export function parseProviderSessionShimArgs(argv: readonly string[]): ProviderSessionShimArgs {
  if (argv.length !== 6 || argv[0] !== '--adapter' || argv[1] !== 'grok-build' ||
      argv[2] !== '--access' || !ACCESS.has(argv[3] as SessionConsoleSandboxAccess) ||
      argv[4] !== '--project-trusted' || !['true', 'false'].includes(argv[5] ?? '')) {
    throw new Error('provider session shim argv is invalid');
  }
  return Object.freeze({
    access: argv[3] as SessionConsoleSandboxAccess,
    adapter: 'grok-build',
    projectTrusted: argv[5] === 'true',
  });
}

function exactPath(value: string | undefined, expected: string, field: string): string {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value !== expected ||
      value.includes('\0')) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function withinWorkspace(value: string): boolean {
  const relation = relative(CONTAINER_WORKSPACE, value);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function requireDirectory(
  path: string,
  owner: number,
  create: boolean,
  allowDesktopMountRoot = false,
): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path ||
      (stat.mode & 0o077) !== 0 || (
        stat.uid !== owner && !(allowDesktopMountRoot && stat.uid === 0)
      )) {
    throw new Error('provider session state directory is invalid');
  }
}

async function requireExecutable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path ||
      (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
    throw new Error('provider session runtime executable is invalid');
  }
}

export function providerSessionGrokConfig(proxyBaseUrl: string): string {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(proxyBaseUrl)) {
    throw new Error('provider session Grok config proxy is invalid');
  }
  return [
    '[models]',
    'default = "agent-deck-broker"',
    '',
    '[model.agent-deck-broker]',
    'model = "grok-4.5"',
    `base_url = "${proxyBaseUrl}"`,
    'name = "Grok 4.5"',
    'env_key = "XAI_API_KEY"',
    'api_backend = "chat_completions"',
    '',
    '[cli]',
    'auto_update = false',
    '',
  ].join('\n');
}

async function writeGrokConfig(proxyBaseUrl: string, owner: number): Promise<void> {
  const path = `${CONTAINER_HOME}/.grok/config.toml`;
  await writeFile(path, providerSessionGrokConfig(proxyBaseUrl), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path ||
      stat.uid !== owner || (stat.mode & 0o777) !== 0o600) {
    throw new Error('provider session Grok config is invalid');
  }
}

async function buildLaunchSpec(
  args: ProviderSessionShimArgs,
  proxyBaseUrl: string,
  dependencies: ProviderSessionShimDependencies,
  browserEnvironment?: Readonly<Record<string, string>>,
): Promise<ProviderSessionShimLaunchSpec> {
  const owner = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    throw new Error('provider session runtime owner is invalid');
  }
  const declaredEnvironment = dependencies.environment ?? process.env;
  exactPath(declaredEnvironment.HOME, CONTAINER_HOME, 'provider session HOME');
  await requireDirectory(
    CONTAINER_STATE,
    owner,
    false,
    inferenceTransport(declaredEnvironment) === 'stdio-multiplex-v1',
  );
  for (const path of [
    CONTAINER_HOME,
    `${CONTAINER_HOME}/.grok`,
    `${CONTAINER_STATE}/cache`,
    `${CONTAINER_STATE}/config`,
    `${CONTAINER_STATE}/state`,
  ]) await requireDirectory(path, owner, true);
  await writeGrokConfig(proxyBaseUrl, owner);
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  if (!withinWorkspace(cwd) || await realpath(cwd) !== cwd) {
    throw new Error('provider session working directory is invalid');
  }
  const binary = dependencies.grokBinary ?? GROK_BINARY;
  await requireExecutable(binary);
  return providerSessionGrokLaunchSpec(
    args,
    proxyBaseUrl,
    cwd,
    binary,
    inferenceTransport(declaredEnvironment) === 'unix-http-v1',
    browserEnvironment,
  );
}

function inferenceTransport(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderSessionInferenceTransport {
  const value = environment.AGENT_DECK_INFERENCE_TRANSPORT;
  if (value !== 'unix-http-v1' && value !== 'stdio-multiplex-v1') {
    throw new Error('provider session inference transport is invalid');
  }
  return value;
}

/** Pure fixed launch projection used by image/packaging validation. */
export function providerSessionGrokLaunchSpec(
  args: ProviderSessionShimArgs,
  proxyBaseUrl: string,
  cwd: string,
  binary = GROK_BINARY,
  nativeSandbox = true,
  browserEnvironment?: Readonly<Record<string, string>>,
): ProviderSessionShimLaunchSpec {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(proxyBaseUrl) ||
      !withinWorkspace(cwd) || binary !== GROK_BINARY || typeof nativeSandbox !== 'boolean' ||
      (browserEnvironment !== undefined && (
        Object.keys(browserEnvironment).join(',') !== 'PATH' ||
        browserEnvironment.PATH !==
          '/state/home/.agent-deck/browser/bin:/opt/agent-deck/providers/grok:/usr/bin:/bin'
      ))) {
    throw new Error('provider session Grok launch projection is invalid');
  }
  return Object.freeze({
    args: Object.freeze([
      ...(args.projectTrusted ? ['--trust'] : []),
      '--sandbox', sandbox(args.access, nativeSandbox), 'agent', '--no-leader', 'stdio',
    ]),
    binary,
    cwd,
    environment: Object.freeze({
      AGENT_DECK_ORIGIN: 'sdk',
      GROK_CLAUDE_HOOKS_ENABLED: '0',
      GROK_CLI_CHAT_PROXY_BASE_URL: proxyBaseUrl,
      GROK_CURSOR_HOOKS_ENABLED: '0',
      GROK_HOME: `${CONTAINER_HOME}/.grok`,
      GROK_MANAGED_BY_NPM: '1',
      GROK_XAI_API_BASE_URL: proxyBaseUrl,
      HOME: CONTAINER_HOME,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: browserEnvironment?.PATH ?? '/opt/agent-deck/providers/grok:/usr/bin:/bin',
      TMPDIR: '/tmp',
      XAI_API_KEY: BROKER_MARKER,
      XDG_CACHE_HOME: `${CONTAINER_STATE}/cache`,
      XDG_CONFIG_HOME: `${CONTAINER_STATE}/config`,
      XDG_STATE_HOME: `${CONTAINER_STATE}/state`,
    }),
  });
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolveExit(128);
      else resolveExit(code ?? 1);
    });
  });
}

/** Container PID 1. It never reads, receives, or persists a real provider credential. */
export async function runProviderSessionShim(
  argv: readonly string[],
  dependencies: ProviderSessionShimDependencies = {},
): Promise<number> {
  const args = parseProviderSessionShimArgs(argv);
  const declaredEnvironment = dependencies.environment ?? process.env;
  const transport = inferenceTransport(declaredEnvironment);
  const brokerSocketPath = transport === 'unix-http-v1'
    ? exactPath(
      dependencies.brokerSocketPath ?? declaredEnvironment.AGENT_DECK_INFERENCE_SOCKET,
      CONTAINER_BROKER,
      'provider session broker socket',
    )
    : null;
  if (transport === 'stdio-multiplex-v1' && (
    dependencies.brokerSocketPath || declaredEnvironment.AGENT_DECK_INFERENCE_SOCKET
  )) throw new Error('provider session broker socket is forbidden for multiplex transport');
  const rawStream = transport === 'stdio-multiplex-v1'
    ? dependencies.transportStream ?? Duplex.from({
      readable: process.stdin,
      writable: process.stdout,
    })
    : null;
  const multiplex = rawStream
    ? new ProviderSessionMultiplexConnection({ role: 'shim', stream: rawStream })
    : null;
  const proxy = new ProviderSessionShimInferenceProxy({
    localModelIds: ['grok-4.5'],
    onFailure: ({ path, reason }) => process.stderr.write(
      `[provider-session-inference] ${path || '[missing-path]'}: ${reason}\n`,
    ),
    upstreamPaths: GROK_UPSTREAM_PATHS,
    ...(multiplex
      ? { invoke: (request, signal) => multiplex.requestInference(request, signal) }
      : { brokerSocketPath: brokerSocketPath! }),
  });
  let child: ChildProcess | null = null;
  let browserRuntime: ProviderSessionBrowserRuntimeHandle | null = null;
  const forward = (signal: NodeJS.Signals): void => {
    try { child?.kill(signal); } catch {}
  };
  const stopOnTransportFailure = (): void => forward('SIGTERM');
  const onTerm = (): void => forward('SIGTERM');
  const onInt = (): void => forward('SIGINT');
  try {
    await proxy.start();
    browserRuntime = await prepareProviderSessionBrowserRuntime({
      encodedContext: declaredEnvironment.AGENT_DECK_BROWSER_CONTEXT_B64,
      multiplex,
      transport: declaredEnvironment.AGENT_DECK_BROWSER_TRANSPORT,
    });
    const launch = await buildLaunchSpec(
      args,
      proxy.baseUrl,
      dependencies,
      browserRuntime?.environment,
    );
    child = (dependencies.spawnProcess ?? spawn)(launch.binary, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.environment },
      shell: false,
      stdio: multiplex ? ['pipe', 'pipe', 'inherit'] : 'inherit',
    });
    if (multiplex) {
      if (!child.stdin || !child.stdout) {
        forward('SIGTERM');
        throw new Error('provider session Grok stdio is unavailable');
      }
      multiplex.acp.once('error', stopOnTransportFailure);
      multiplex.acp.pipe(child.stdin);
      child.stdout.pipe(multiplex.acp);
    }
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    return await waitForChild(child);
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    multiplex?.acp.removeListener('error', stopOnTransportFailure);
    child?.stdout?.unpipe(multiplex?.acp);
    multiplex?.acp.unpipe(child?.stdin ?? undefined);
    await browserRuntime?.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await multiplex?.close().catch(() => undefined);
  }
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) {
  void runProviderSessionShim(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write('Provider session runtime failed closed.\n');
      process.exitCode = 1;
    },
  );
}
