import { isAbsolute, join, normalize } from 'node:path';

const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const NUL_CHARACTER = '\u0000';

export interface DaemonPathEnvironment {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_RUNTIME_DIR?: string;
  readonly XDG_STATE_HOME?: string;
}

export interface DaemonInstancePathOptions {
  /** Local Workers use the Core storage namespace directly and never open daemon ingress. */
  readonly controlSocket: 'required' | 'unused';
}

export interface DaemonInstancePaths {
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly configurationDirectory: string;
  readonly logDirectory: string;
  readonly runtimeDirectory: string;
  readonly socketPath: string;
}

export class DaemonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonPathError';
  }
}

export function assertInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new DaemonPathError(
      'instanceId must be a lowercase ASCII label of 1-63 letters, digits, or interior hyphens',
    );
  }
}

function requireAbsoluteDirectory(value: string | undefined, label: string): string {
  if (!value) throw new DaemonPathError(`${label} is required`);
  if (value.includes(NUL_CHARACTER) || !isAbsolute(value)) {
    throw new DaemonPathError(`${label} must be an absolute path`);
  }
  const normalized = normalize(value);
  if (normalized !== value || normalized === '/') {
    throw new DaemonPathError(`${label} must be normalized and cannot be the filesystem root`);
  }
  return normalized;
}

function resolveHome(environment: DaemonPathEnvironment): string {
  return requireAbsoluteDirectory(environment.HOME, 'HOME');
}

function resolveXdgDirectory(
  environment: DaemonPathEnvironment,
  key: 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME',
  fallbackSuffix: readonly string[],
): string {
  const explicit = environment[key];
  if (explicit !== undefined) return requireAbsoluteDirectory(explicit, key);
  return join(resolveHome(environment), ...fallbackSuffix);
}

export function resolveDaemonInstancePaths(
  instanceId: string,
  environment: DaemonPathEnvironment = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  },
  options: DaemonInstancePathOptions = { controlSocket: 'required' },
): DaemonInstancePaths {
  assertInstanceId(instanceId);
  const stateHome = resolveXdgDirectory(environment, 'XDG_STATE_HOME', ['.local', 'state']);
  const configHome = resolveXdgDirectory(environment, 'XDG_CONFIG_HOME', ['.config']);
  const runtimeHome = requireAbsoluteDirectory(environment.XDG_RUNTIME_DIR, 'XDG_RUNTIME_DIR');
  const instanceSegments = ['agent-deck', 'instances', instanceId] as const;
  const stateDirectory = join(stateHome, ...instanceSegments);
  const configurationDirectory = join(configHome, ...instanceSegments);
  const runtimeDirectory = join(runtimeHome, 'agent-deck', instanceId);
  const socketPath = join(runtimeDirectory, 'agent-deckd.sock');

  if (
    options.controlSocket === 'required' &&
    Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new DaemonPathError(
      `Unix socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes: ${socketPath}`,
    );
  }

  return Object.freeze({
    instanceId,
    stateDirectory,
    configurationDirectory,
    logDirectory: join(stateDirectory, 'logs'),
    runtimeDirectory,
    socketPath,
  });
}
