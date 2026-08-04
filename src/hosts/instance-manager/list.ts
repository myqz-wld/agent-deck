import { posix } from 'node:path';

import { requireCanonicalDirectory, requireOwnedDirectory } from './artifacts';
import type { InstanceManagerContext } from './context';
import { loadInstance } from './instance-reader';
import type { InstanceSummary, ManagedTopology } from './types';
import { fail, sameIdentity, validateInstanceId } from './validation';

export async function listInstances(
  context: InstanceManagerContext,
  withLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>,
): Promise<readonly InstanceSummary[]> {
  const summaries: InstanceSummary[] = [];
  for (const topology of ['full', 'relay'] as const satisfies readonly ManagedTopology[]) {
    const topologyRoot = posix.join(context.roots.metadataRoot, topology);
    const journalTopologyRoot = posix.join(context.roots.journalRoot, topology);
    const rootIdentity = await context.ports.fileSystem.lstat(topologyRoot);
    const metadataEntries = new Map<string, Awaited<ReturnType<typeof context.ports.fileSystem.listDirectory>>[number]>();
    if (rootIdentity) {
      await requireCanonicalDirectory(context.ports.fileSystem, topologyRoot, `${topology} metadata root`);
      for (const entry of await context.ports.fileSystem.listDirectory(topologyRoot, 1_024)) metadataEntries.set(entry.name, entry);
    }
    const instanceIds = new Set(metadataEntries.keys());
    if (await context.ports.fileSystem.lstat(journalTopologyRoot)) {
      await requireOwnedDirectory(context.ports.fileSystem, journalTopologyRoot, context.serviceUid, 0o700, `${topology} journal root`);
      for (const entry of await context.ports.fileSystem.listDirectory(journalTopologyRoot, 1_024)) {
        const match = /^([a-z0-9][a-z0-9-]*)\.journal\.json$/.exec(entry.name);
        if (!match || entry.identity.kind !== 'file') fail('recovery_required', 'journal namespace contains an interrupted or invalid entry');
        validateInstanceId(match[1]);
        instanceIds.add(match[1]);
      }
    }
    for (const instanceId of [...instanceIds].sort()) {
      const entry = metadataEntries.get(instanceId);
      if (entry && entry.identity.kind !== 'directory') fail('tampered', 'metadata root contains a non-directory entry');
      validateInstanceId(instanceId);
      const entryPath = posix.join(topologyRoot, instanceId);
      const loaded = await withLock(`${topology}:${instanceId}`, async () => {
        if (!entry) return null;
        const current = await context.ports.fileSystem.lstat(entryPath);
        if (!current) return null;
        if (!sameIdentity(current, entry.identity)) {
          fail('tampered', 'instance metadata identity changed during list');
        }
        return loadInstance({
          selector: { topology, instanceId },
          roots: context.roots,
          ports: context.ports,
          maxArtifactBytes: context.limits.maxArtifactBytes,
          serviceUid: context.serviceUid,
        });
      });
      if (!loaded) continue;
      summaries.push({
        topology,
        instanceId,
        generation: loaded.record.generation,
        currentVersion: loaded.record.currentVersion,
        image: loaded.current.image,
        unitName: loaded.paths.unitName,
        unitPath: loaded.paths.unitPath,
      });
    }
  }
  return summaries.sort((left, right) => {
    const a = `${left.topology}:${left.instanceId}`;
    const b = `${right.topology}:${right.instanceId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
