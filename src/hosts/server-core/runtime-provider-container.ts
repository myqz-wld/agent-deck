import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { JsonObject } from '@contracts/index';
import type { WorkspaceSandboxSpec } from '@contracts/workspace-sandbox';

import {
  createProductionServerCoreProviderGrokContainer,
  type ProductionServerCoreProviderGrokContainer,
  type ProductionServerCoreProviderGrokContainerOptions,
} from './provider-grok-container-production';
import type { ServerCoreProviderWorkspaceBoundary } from './provider-host-common';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreRuntimeFactoryInput } from './root';
import { providerSessionRuntimePaths } from '@hosts/provider-session/runtime-paths';

export const SERVER_CORE_PROVIDER_INFERENCE_CREDENTIAL_ROOT =
  '/run/secrets/agent-deck/provider-inference';

export type ServerCoreProviderGrokContainerPort = Pick<
  ProductionServerCoreProviderGrokContainer,
  'close' | 'processFactory' | 'readiness'
>;

export interface ServerCoreProviderContainerRuntimePaths {
  readonly brokerRoot: string;
  readonly privateRoot: string;
  readonly supervisorRoot: string;
  readonly supervisorSocketPath: string;
}

interface ResolverDependencies {
  readonly createContainer?: (
    options: ProductionServerCoreProviderGrokContainerOptions,
  ) => ServerCoreProviderGrokContainerPort;
  readonly credentialRoot?: string;
  readonly currentUid?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly workspaceSandbox?: WorkspaceSandboxSpec;
}

function ensurePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    (stat.mode & 0o077) !== 0 || (currentUid !== null && stat.uid !== currentUid)
  ) throw new Error('provider private directory is not process-private');
  return path;
}

export function validateServerCoreProviderContainerOption(runtimeOptions: JsonObject): boolean {
  const candidate = runtimeOptions.providerContainer;
  if (candidate === undefined) return false;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('runtimeOptions.providerContainer must be an object');
  }
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || value.schemaVersion !== 1) {
    throw new Error('runtimeOptions.providerContainer must be exact schemaVersion 1');
  }
  return true;
}

/** Stable, short namespace shared by the Core view and the host's exact socket-volume mapping. */
export function resolveServerCoreProviderContainerRuntimePaths(
  input: ServerCoreRuntimeFactoryInput,
  sandbox?: WorkspaceSandboxSpec,
  dependencies: Pick<ResolverDependencies, 'currentUid' | 'platform'> = {},
): ServerCoreProviderContainerRuntimePaths {
  const uid = (dependencies.currentUid ?? (() =>
    typeof process.getuid === 'function' ? process.getuid() : -1))();
  const paths = providerSessionRuntimePaths({
    instanceId: input.instanceId,
    platform: dependencies.platform ?? process.platform,
    runtimeParent: dirname(input.paths.runtimeDirectory),
    uid,
    ...(sandbox ? { workerConfigId: sandbox.workerConfigId } : {}),
  });
  return Object.freeze({
    brokerRoot: paths.brokerRoot,
    privateRoot: paths.privateRoot,
    supervisorRoot: paths.supervisorRoot,
    supervisorSocketPath: paths.supervisorSocketPath,
  });
}

export function resolveServerCoreProviderWorkspaceBoundary(
  input: ServerCoreRuntimeFactoryInput,
  workspaceRoot: string,
  sandbox: WorkspaceSandboxSpec | undefined,
): ServerCoreProviderWorkspaceBoundary {
  if (sandbox) {
    if (sandbox.workspaceRoot !== workspaceRoot) {
      throw new Error('provider workspace root does not match the Worker sandbox');
    }
    return Object.freeze({
      workspaceRoot,
      privateRoot: sandbox.privateRoot,
      providerHomeRoot: sandbox.environment.providerHomeRoot,
      runtimeReadRoots: Object.freeze([...sandbox.runtimeReadRoots]),
      providerCacheRoot: sandbox.environment.providerCacheRoot,
      providerTempRoot: sandbox.environment.providerTempRoot,
    });
  }
  const privateRoot = ensurePrivateDirectory(input.paths.stateDirectory);
  return Object.freeze({
    workspaceRoot,
    privateRoot,
    providerHomeRoot: ensurePrivateDirectory(join(privateRoot, 'provider-home')),
    runtimeReadRoots: Object.freeze(['/opt/agent-deck']),
    providerCacheRoot: ensurePrivateDirectory(join(privateRoot, 'provider-cache')),
    providerTempRoot: ensurePrivateDirectory(join(privateRoot, 'provider-tmp')),
  });
}

/** Creates the production boundary only for the exact opt-in; environmental absence stays closed. */
export function resolveServerCoreProviderGrokContainer(
  input: ServerCoreRuntimeFactoryInput,
  workspaceRoot: string,
  diagnostics: ServerCoreRuntimeDiagnostics,
  dependencies: ResolverDependencies = {},
): ServerCoreProviderGrokContainerPort | null {
  if (!validateServerCoreProviderContainerOption(input.runtimeOptions)) return null;
  try {
    const paths = resolveServerCoreProviderContainerRuntimePaths(
      input,
      dependencies.workspaceSandbox,
      dependencies,
    );
    ensurePrivateDirectory(paths.privateRoot);
    ensurePrivateDirectory(paths.brokerRoot);
    ensurePrivateDirectory(paths.supervisorRoot);
    return (dependencies.createContainer ??
      createProductionServerCoreProviderGrokContainer)({
      brokerRoot: paths.brokerRoot,
      credentialRoot: dependencies.credentialRoot ??
        SERVER_CORE_PROVIDER_INFERENCE_CREDENTIAL_ROOT,
      instanceId: input.instanceId,
      supervisorSocketPath: paths.supervisorSocketPath,
      workspaceRoot,
    });
  } catch (error) {
    try { diagnostics.warn('Provider Grok container boundary is unavailable', undefined, error); } catch {}
    return null;
  }
}
