import { createRequire } from 'node:module';

interface SqliteProbeDatabase {
  close(): void;
}

interface SqliteConstructor {
  new (filename: string): SqliteProbeDatabase;
}

export interface NodeRuntimeVersions {
  readonly node?: string;
  readonly modules?: string;
  readonly electron?: string;
}

export interface SqliteAbiPreflightOptions {
  readonly allowElectronAsNode?: boolean;
  readonly loadModule?: () => unknown;
  readonly runtimeVersions?: NodeRuntimeVersions;
}

export interface SqliteAbiPreflightResult {
  readonly moduleName: 'better-sqlite3';
  readonly runtimeNodeVersion: string;
  readonly runtimeAbi: string;
  readonly probeDatabase: ':memory:';
}

export type SqliteAbiPreflightErrorCode =
  | 'electron_runtime'
  | 'invalid_module'
  | 'native_load_failed'
  | 'runtime_abi_unavailable';

export class SqliteAbiPreflightError extends Error {
  constructor(
    readonly code: SqliteAbiPreflightErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SqliteAbiPreflightError';
  }
}

const requireFromDaemon = createRequire(import.meta.url);

function defaultLoadModule(): unknown {
  return requireFromDaemon('better-sqlite3');
}

function resolveConstructor(loaded: unknown): SqliteConstructor {
  const candidate =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded
      ? (loaded as { default: unknown }).default
      : loaded;
  if (typeof candidate !== 'function') {
    throw new SqliteAbiPreflightError(
      'invalid_module',
      'The daemon better-sqlite3 artifact did not export a database constructor',
    );
  }
  return candidate as SqliteConstructor;
}

/**
 * Loads the daemon's Node-native binding and opens only a throwaway in-memory probe. It never
 * receives or derives a desktop database path, so an Electron ABI mismatch cannot be hidden by a
 * production database open.
 */
export function preflightNodeNativeSqlite(
  options: SqliteAbiPreflightOptions = {},
): SqliteAbiPreflightResult {
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  if (runtimeVersions.electron && !options.allowElectronAsNode) {
    throw new SqliteAbiPreflightError(
      'electron_runtime',
      'agent-deckd SQLite preflight must run in Node, not an Electron runtime',
    );
  }
  if (!runtimeVersions.node || !runtimeVersions.modules) {
    throw new SqliteAbiPreflightError(
      'runtime_abi_unavailable',
      'Node runtime version or NODE_MODULE_VERSION is unavailable',
    );
  }

  let database: SqliteProbeDatabase | undefined;
  try {
    const Database = resolveConstructor((options.loadModule ?? defaultLoadModule)());
    database = new Database(':memory:');
    database.close();
    database = undefined;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the load/ABI failure as the actionable startup error.
    }
    if (error instanceof SqliteAbiPreflightError) throw error;
    throw new SqliteAbiPreflightError(
      'native_load_failed',
      `Node-native better-sqlite3 preflight failed for ABI ${runtimeVersions.modules}`,
      error,
    );
  }

  return Object.freeze({
    moduleName: 'better-sqlite3',
    runtimeNodeVersion: runtimeVersions.node,
    runtimeAbi: runtimeVersions.modules,
    probeDatabase: ':memory:',
  });
}
