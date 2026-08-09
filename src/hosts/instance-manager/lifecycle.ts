import type { InstanceManagerContext } from './context';
import type { InstancePaths } from './paths';
import { evidencePaths, revalidateEvidence, validateStartEvidence } from './evidence';
import { loadInstance, revalidateLoadedArtifacts, type LoadedInstance } from './instance-reader';
import { runStartPreflight } from './preflight';
import { validateImageAvailable } from './create';
import { waitForHealthyContainer } from './container-health';
import { verifyFullRuntimeConfig } from './full-runtime-config';
import type { InstanceSelector, InstanceStatus, InstanceSummary, SystemdUnitStatus } from './types';
import { fail, InstanceManagerError } from './validation';

function summary(loaded: LoadedInstance): InstanceSummary {
  return {
    topology: loaded.record.topology,
    instanceId: loaded.record.instanceId,
    generation: loaded.record.generation,
    currentVersion: loaded.record.currentVersion,
    image: loaded.current.image,
    unitName: loaded.paths.unitName,
    unitPath: loaded.paths.unitPath,
  };
}

function assertExactLoadedUnitStatus(paths: InstancePaths, status: SystemdUnitStatus): void {
  const validLoadState = ['loaded', 'not-found', 'error'].includes(status.loadState);
  const validActiveState = [
    'active',
    'activating',
    'deactivating',
    'failed',
    'inactive',
  ].includes(status.activeState);
  if (
    !validLoadState ||
    !validActiveState ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(status.subState) ||
    status.unitName !== paths.unitName ||
    status.loadState !== 'loaded' ||
    status.fragmentPath !== paths.unitPath
  ) {
    fail('tampered', 'systemd returned a different or untrusted user unit');
  }
}

function assertExactUnitStatus(loaded: LoadedInstance, status: SystemdUnitStatus): void {
  assertExactLoadedUnitStatus(loaded.paths, status);
}

async function statusLoaded(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
): Promise<SystemdUnitStatus> {
  const status = await context.ports.systemd.statusUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  assertExactUnitStatus(loaded, status);
  return status;
}

export async function statusInstance(
  context: InstanceManagerContext,
  selector: InstanceSelector,
): Promise<InstanceStatus> {
  const loaded = await loadInstance({
    selector,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  return { ...summary(loaded), systemd: await statusLoaded(context, loaded) };
}

export async function startInstance(
  context: InstanceManagerContext,
  selector: InstanceSelector,
): Promise<InstanceStatus> {
  const loaded = await loadInstance({
    selector,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  if (loaded.record.topology === 'full') {
    await verifyFullRuntimeConfig(
      context,
      loaded.record.instanceId,
      loaded.current.configSha256,
    );
  }
  await validateImageAvailable(context, loaded.current.image);
  const evidenceSnapshots = await validateStartEvidence({
    topology: loaded.record.topology,
    paths: loaded.paths,
    generation: loaded.record.generation,
    version: loaded.current,
    fileSystem: context.ports.fileSystem,
    clock: context.ports.clock,
    serviceUid: context.serviceUid,
    trustedRootUid: context.trustedRootUid,
    maxAgeMs: context.limits.maxEvidenceAgeMs,
  });
  const evidence = evidencePaths(loaded.record.topology, loaded.paths);
  await runStartPreflight({
    topology: loaded.record.topology,
    paths: loaded.paths,
    renderedArtifactPath: loaded.current.unitBackupPath,
    egressEvidencePath: evidence[0],
    quotaEvidencePath: evidence[1],
    context,
  });
  await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
  await revalidateEvidence(context.ports.fileSystem, evidenceSnapshots, context.ports.clock, context.limits.maxEvidenceAgeMs);
  await revalidateLoadedArtifacts({ loaded, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
  if (loaded.record.topology === 'full') {
    await verifyFullRuntimeConfig(
      context,
      loaded.record.instanceId,
      loaded.current.configSha256,
    );
  }
  let attemptedStart = false;
  try {
    attemptedStart = true;
    await context.ports.systemd.startUserUnit(
      loaded.paths.unitName,
      context.limits.lifecycleTimeoutMs,
    );
    await waitForHealthyContainer(context, {
      name: loaded.paths.containerName,
      image: loaded.current.image,
    });
    const systemd = await statusLoaded(context, loaded);
    if (systemd.activeState !== 'active') fail('health_failed', 'exact systemd user unit is not active after start');
    return { ...summary(loaded), systemd };
  } catch (primary) {
    if (!attemptedStart) throw primary;
    try {
      await context.ports.systemd.stopUserUnit(loaded.paths.unitName, context.limits.lifecycleTimeoutMs);
      const stopped = await statusLoaded(context, loaded);
      if (stopped.activeState !== 'inactive') throw new Error('exact unit remained active after cleanup stop');
    } catch (cleanup) {
      throw new InstanceManagerError('cleanup_failed', 'start failed and the exact unit could not be stopped', { cause: new AggregateError([primary, cleanup]) });
    }
    throw primary;
  }
}

export async function stopInstance(
  context: InstanceManagerContext,
  selector: InstanceSelector,
): Promise<InstanceStatus> {
  const loaded = await loadInstance({
    selector,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  const before = await statusLoaded(context, loaded);
  if (before.activeState !== 'inactive') {
    await context.ports.systemd.stopUserUnit(
      loaded.paths.unitName,
      context.limits.lifecycleTimeoutMs,
    );
  }
  const systemd = await statusLoaded(context, loaded);
  if (systemd.activeState !== 'inactive') {
    fail('command_failed', 'exact systemd user unit did not stop');
  }
  return { ...summary(loaded), systemd };
}

export { assertExactLoadedUnitStatus, assertExactUnitStatus, statusLoaded, summary };
