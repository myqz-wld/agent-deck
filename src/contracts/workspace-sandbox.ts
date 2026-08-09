export const WORKSPACE_SANDBOX_SCHEMA_VERSION = 1;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_PATH_BYTES = 4_096;
const MAX_RUNTIME_ROOTS = 32;

export type WorkspaceSandboxExecution = 'full-worker' | 'relay-worker';
export type ProviderWorkspaceAccess = 'outer-full' | 'read-only' | 'workspace-write';

export interface WorkspaceSandboxEnvironment {
  coreConfigRoot: string;
  coreRuntimeRoot: string;
  coreStateRoot: string;
  providerCacheRoot: string;
  providerHomeRoot: string;
  providerTempRoot: string;
}

export interface WorkspaceSandboxSpec {
  schemaVersion: typeof WORKSPACE_SANDBOX_SCHEMA_VERSION;
  execution: WorkspaceSandboxExecution;
  workerConfigId: string;
  workerId: string;
  workspaceRoot: string;
  privateRoot: string;
  runtimeReadRoots: readonly string[];
  environment: WorkspaceSandboxEnvironment;
  networkBoundary: 'provider-controlled';
}

export interface ProviderChildSandboxPolicy {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
  selectedDirectory: string;
  workspaceAccess: ProviderWorkspaceAccess;
  networkBoundary: 'provider-controlled';
}

export interface EffectiveProviderSandboxPolicy {
  adapterId: ProviderChildSandboxPolicy['adapterId'];
  workspaceAccess: 'read-only' | 'read-write';
  readOnlyRoots: readonly string[];
  readWriteRoots: readonly string[];
  networkBoundary: 'provider-controlled';
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} contains missing or unexpected fields`);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function absolutePosixPath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || value[0] !== '/' || CONTROL.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES ||
    (value.length > 1 && value.endsWith('/')) || value.includes('//') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`${field} must be one normalized absolute path`);
  }
  return value;
}

function within(parent: string, child: string): boolean {
  return parent === '/' ? child.startsWith('/') : child === parent || child.startsWith(`${parent}/`);
}

function disjoint(left: string, right: string, field: string): void {
  if (within(left, right) || within(right, left)) {
    throw new Error(`${field} roots must not overlap`);
  }
}

function parseEnvironment(value: unknown, privateRoot: string): WorkspaceSandboxEnvironment {
  const raw = record(value, 'workspace sandbox environment');
  exactKeys(raw, [
    'coreConfigRoot',
    'coreRuntimeRoot',
    'coreStateRoot',
    'providerCacheRoot',
    'providerHomeRoot',
    'providerTempRoot',
  ], 'workspace sandbox environment');
  const environment = {
    coreConfigRoot: absolutePosixPath(raw.coreConfigRoot, 'coreConfigRoot'),
    coreRuntimeRoot: absolutePosixPath(raw.coreRuntimeRoot, 'coreRuntimeRoot'),
    coreStateRoot: absolutePosixPath(raw.coreStateRoot, 'coreStateRoot'),
    providerCacheRoot: absolutePosixPath(raw.providerCacheRoot, 'providerCacheRoot'),
    providerHomeRoot: absolutePosixPath(raw.providerHomeRoot, 'providerHomeRoot'),
    providerTempRoot: absolutePosixPath(raw.providerTempRoot, 'providerTempRoot'),
  };
  const paths = Object.values(environment);
  if (new Set(paths).size !== paths.length || paths.some((path) => !within(privateRoot, path))) {
    throw new Error('workspace sandbox environment must contain distinct private-root children');
  }
  if (paths.some((path) => path === privateRoot)) {
    throw new Error('workspace sandbox environment cannot expose the whole private root');
  }
  return Object.freeze(environment);
}

export function parseWorkspaceSandboxSpec(value: unknown): WorkspaceSandboxSpec {
  const raw = record(value, 'workspace sandbox');
  exactKeys(raw, [
    'environment', 'execution', 'networkBoundary', 'privateRoot',
    'runtimeReadRoots', 'schemaVersion', 'workerId', 'workspaceRoot',
    'workerConfigId',
  ], 'workspace sandbox');
  if (raw.schemaVersion !== WORKSPACE_SANDBOX_SCHEMA_VERSION) {
    throw new Error('workspace sandbox schemaVersion is unsupported');
  }
  if (raw.execution !== 'full-worker' && raw.execution !== 'relay-worker') {
    throw new Error('workspace sandbox execution is invalid');
  }
  if (raw.networkBoundary !== 'provider-controlled') {
    throw new Error('workspace sandbox network boundary is invalid');
  }
  const workspaceRoot = absolutePosixPath(raw.workspaceRoot, 'workspaceRoot');
  const privateRoot = absolutePosixPath(raw.privateRoot, 'privateRoot');
  disjoint(workspaceRoot, privateRoot, 'workspace and private');
  if (!Array.isArray(raw.runtimeReadRoots) || raw.runtimeReadRoots.length > MAX_RUNTIME_ROOTS) {
    throw new Error('workspace sandbox runtimeReadRoots are invalid');
  }
  const runtimeReadRoots = raw.runtimeReadRoots.map((path, index) =>
    absolutePosixPath(path, `runtimeReadRoots[${index}]`));
  if (new Set(runtimeReadRoots).size !== runtimeReadRoots.length) {
    throw new Error('workspace sandbox runtimeReadRoots contain duplicates');
  }
  for (const root of runtimeReadRoots) {
    disjoint(root, workspaceRoot, 'runtime and workspace');
    disjoint(root, privateRoot, 'runtime and private');
  }
  return Object.freeze({
    schemaVersion: WORKSPACE_SANDBOX_SCHEMA_VERSION,
    execution: raw.execution,
    workerConfigId: token(raw.workerConfigId, 'workerConfigId'),
    workerId: token(raw.workerId, 'workerId'),
    workspaceRoot,
    privateRoot,
    runtimeReadRoots: Object.freeze(runtimeReadRoots),
    environment: parseEnvironment(raw.environment, privateRoot),
    networkBoundary: 'provider-controlled',
  });
}

export function intersectProviderSandboxPolicy(
  spec: WorkspaceSandboxSpec,
  requested: ProviderChildSandboxPolicy,
): EffectiveProviderSandboxPolicy {
  if (requested.networkBoundary !== 'provider-controlled') {
    throw new Error('provider child policy cannot widen the outer network boundary');
  }
  if (!['claude-code', 'codex-cli', 'grok-build'].includes(requested.adapterId)) {
    throw new Error('provider child adapter is invalid');
  }
  if (!['outer-full', 'read-only', 'workspace-write'].includes(requested.workspaceAccess)) {
    throw new Error('provider child workspace access is invalid');
  }
  const selectedDirectory = absolutePosixPath(
    requested.selectedDirectory,
    'provider child selectedDirectory',
  );
  if (!within(spec.workspaceRoot, selectedDirectory)) {
    throw new Error('provider child selectedDirectory escapes the Workspace');
  }
  const readOnlyWorkspace = requested.workspaceAccess === 'read-only';
  const selectedWrite = requested.workspaceAccess === 'workspace-write';
  const fullWrite = requested.workspaceAccess === 'outer-full';
  return Object.freeze({
    adapterId: requested.adapterId,
    workspaceAccess: readOnlyWorkspace ? 'read-only' : 'read-write',
    readOnlyRoots: Object.freeze([
      ...spec.runtimeReadRoots,
      ...(!fullWrite ? [spec.workspaceRoot] : []),
    ]),
    readWriteRoots: Object.freeze([
      ...(fullWrite ? [spec.workspaceRoot] : []),
      ...(selectedWrite ? [selectedDirectory] : []),
    ]),
    networkBoundary: 'provider-controlled',
  });
}
