import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { LinuxInstanceManager, type InstanceManagerOptions } from '../manager';
import type { InstanceManagerPorts, InstanceManagerRoots, ManagerLimits } from '../types';
import { LinuxBoundedCommandRunner, type LinuxCommandRunnerOptions } from './bounded-command';
import { FlockHostInstanceLeasePort, type FlockLeaseOptions } from './flock-lease';
import { LinuxDescriptorFileSystem } from './linux-filesystem';
import { RootlessPodmanCommandPort, type RootlessPodmanPortOptions } from './podman-rootless';
import { SystemdUserCommandPort, type SystemdUserPortOptions } from './systemd-user';

export interface ProductionLinuxInstanceManagerOptions {
  readonly roots: InstanceManagerRoots;
  readonly limits: ManagerLimits;
  readonly serviceUid: number;
  readonly trustedRootUid: number;
  readonly trustedArtifactUid: number;
  readonly lockRoot: string;
  readonly commands?: Omit<LinuxCommandRunnerOptions, 'platform'>;
  readonly systemd?: Pick<SystemdUserPortOptions, 'maxOutputBytes'>;
  readonly podman?: Pick<RootlessPodmanPortOptions, 'maxOutputBytes'>;
  readonly leases?: Omit<
    FlockLeaseOptions,
    'lockRoot' | 'platform' | 'testOnlyDirectPaths'
  >;
}

export function createProductionLinuxInstanceManagerPorts(
  options: ProductionLinuxInstanceManagerOptions,
): InstanceManagerPorts {
  if (
    !Number.isSafeInteger(options.serviceUid) ||
    options.serviceUid <= 0 ||
    options.roots.runtimeRoot !== `/run/user/${options.serviceUid}`
  ) {
    throw new Error('production rootless runtime identity is invalid');
  }
  const environment = Object.freeze({
    HOME: options.roots.serviceHome,
    XDG_RUNTIME_DIR: options.roots.runtimeRoot,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${options.roots.runtimeRoot}/bus`,
  });
  const commands = new LinuxBoundedCommandRunner({
    terminateGraceMs: options.commands?.terminateGraceMs,
    finalExitWaitMs: options.commands?.finalExitWaitMs,
  }, undefined, environment);
  return Object.freeze({
    fileSystem: new LinuxDescriptorFileSystem(),
    commands,
    systemd: new SystemdUserCommandPort(commands, {
      maxOutputBytes: options.systemd?.maxOutputBytes,
    }),
    podman: new RootlessPodmanCommandPort(commands, {
      maxOutputBytes: options.podman?.maxOutputBytes,
    }),
    clock: Object.freeze({
      nowMs: () => Date.now(),
      sleep: async (ms: number) => {
        await delay(ms);
      },
    }),
    ids: Object.freeze({ nextId: () => randomUUID() }),
    leases: new FlockHostInstanceLeasePort({
      lockRoot: options.lockRoot,
      flockExecutable: options.leases?.flockExecutable,
      holderExecutable: options.leases?.holderExecutable,
      releaseTimeoutMs: options.leases?.releaseTimeoutMs,
    }),
  });
}

export function createProductionLinuxInstanceManager(
  options: ProductionLinuxInstanceManagerOptions,
): LinuxInstanceManager {
  const manager: InstanceManagerOptions = {
    ports: createProductionLinuxInstanceManagerPorts(options),
    roots: options.roots,
    limits: options.limits,
    serviceUid: options.serviceUid,
    trustedRootUid: options.trustedRootUid,
    trustedArtifactUid: options.trustedArtifactUid,
  };
  return new LinuxInstanceManager(manager);
}
