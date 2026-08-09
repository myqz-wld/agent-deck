import { NodeProviderSessionMounts } from './node-mounts';
import { NodeProviderSessionOci, type NodeProviderSessionOciOptions } from './node-oci';
import { createProviderSessionTransportListener } from './node-transport-listener';
import { ProviderSessionContainerSupervisor } from './supervisor';
import { ProviderSessionSupervisorTransportServer } from './supervisor-transport-server';
import type { ProviderSessionImageCatalog } from './types';

export interface ProductionProviderSessionSupervisorHostOptions
  extends NodeProviderSessionOciOptions {
  readonly brokerRoot: string;
  readonly coreProcessId: string;
  readonly currentGid?: () => number;
  readonly images: ProviderSessionImageCatalog;
  readonly instanceId: string;
  readonly maxActive?: number;
  readonly privateRoot: string;
  readonly stateRoot: string;
  readonly transportRuntimeDirectory: string;
  readonly transportSocketPath: string;
  readonly workspaceRoot: string;
}

/**
 * Host-only production composition. The private socket is the sole Core-facing surface; the
 * engine executable/socket, image catalog, mount roots, and child runner remain in this process.
 */
export function createProductionProviderSessionSupervisorHost(
  options: ProductionProviderSessionSupervisorHostOptions,
): ProviderSessionSupervisorTransportServer {
  const uid = (options.currentUid ?? (() =>
    typeof process.getuid === 'function' ? process.getuid() : -1))();
  const gid = (options.currentGid ?? (() =>
    typeof process.getgid === 'function' ? process.getgid() : -1))();
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('provider session host user identity is invalid');
  }
  const mounts = new NodeProviderSessionMounts({
    brokerRoot: options.brokerRoot,
    currentUid: () => uid,
    inferenceTransport: options.engine === 'docker-desktop'
      ? 'stdio-multiplex-v1'
      : 'unix-http-v1',
    privateRoot: options.privateRoot,
    stateRoot: options.stateRoot,
    workspaceRoot: options.workspaceRoot,
  });
  const oci = new NodeProviderSessionOci({
    attachmentProcess: options.attachmentProcess,
    currentUid: () => uid,
    desktopSocketPath: options.desktopSocketPath,
    desktopVm: options.desktopVm,
    engine: options.engine,
    executable: options.executable,
    platform: options.platform,
    process: options.process,
    rootlessHome: options.rootlessHome,
    rootlessRuntimeDirectory: options.rootlessRuntimeDirectory,
  });
  const supervisor = new ProviderSessionContainerSupervisor({
    coreProcessId: options.coreProcessId,
    engine: options.engine,
    executable: options.executable,
    images: options.images,
    instanceId: options.instanceId,
    maxActive: options.maxActive,
    mounts,
    oci,
    runtimeUser: { gid, uid },
  });
  return new ProviderSessionSupervisorTransportServer({
    listener: createProviderSessionTransportListener({
      platform: options.platform ?? process.platform,
      privateRoot: options.privateRoot,
      runtimeDirectory: options.transportRuntimeDirectory,
      socketPath: options.transportSocketPath,
    }),
    prepare: () => oci.reconcileManaged(options.instanceId),
    supervisor,
  });
}
