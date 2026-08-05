import { describe, expect, it } from 'vitest';

import {
  createHarness,
  DIGEST_A,
  DIGEST_B,
  FULL_RESOURCES,
  seedEvidence,
} from './test-fixtures';

async function runningFull() {
  const harness = createHarness();
  await harness.manager.create({
    topology: 'full',
    instanceId: 'tenant-a',
    version: 'v1',
    image: DIGEST_A,
    runtimeConfig: { revision: 1 },
    fullResources: FULL_RESOURCES,
  });
  seedEvidence(harness, 'full', 'tenant-a');
  await harness.manager.start({ topology: 'full', instanceId: 'tenant-a' });
  return harness;
}

function mirroredConfig(harness: Awaited<ReturnType<typeof runningFull>>): string {
  const root = harness.podman.volumeDataPaths.get('agent-deck-tenant-a-state');
  if (!root) throw new Error('missing Full state volume path');
  return harness.fileSystem.readText(
    `${root}/config/agent-deck/instances/tenant-a/config.json`,
  );
}

describe('LinuxInstanceManager upgrade and rollback', () => {
  it('health-gates upgrade and retains both recoverable generations', async () => {
    const harness = await runningFull();
    await expect(
      harness.manager.planUpgrade({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        nextVersion: 'v2',
        nextImage: DIGEST_B,
        runtimeConfig: { revision: 2 },
        fullResources: { ...FULL_RESOURCES, cpuCores: 3 },
      }),
    ).resolves.toMatchObject({ action: 'upgrade', generation: 2, version: 'v2', destructive: true });
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B, fullResources: { ...FULL_RESOURCES, cpuCores: 3 } });
    const upgraded = await harness.manager.upgrade({
      topology: 'full',
      instanceId: 'tenant-a',
      expectedGeneration: 1,
      expectedVersion: 'v1',
      nextVersion: 'v2',
      nextImage: DIGEST_B,
      runtimeConfig: { revision: 2 },
      fullResources: { ...FULL_RESOURCES, cpuCores: 3 },
    });

    expect(upgraded).toMatchObject({ generation: 2, currentVersion: 'v2', image: DIGEST_B });
    expect(mirroredConfig(harness)).toBe('{\n  "revision": 2\n}\n');
    expect(
      harness.fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container'),
    ).toContain(`Image=${DIGEST_B}`);
    for (const version of ['v1', 'v2']) {
      expect(
        harness.fileSystem.exists(
          `/srv/manager-backups/full/tenant-a/${version}/agent-deck-full@.container`,
        ),
      ).toBe(true);
      expect(
        harness.fileSystem.exists(
          `/srv/manager-backups/full/tenant-a/${version}/runtime-config.json`,
        ),
      ).toBe(true);
    }

    seedEvidence(harness, 'full', 'tenant-a', { generation: 3, version: 'v1', image: DIGEST_A });
    const rolledBack = await harness.manager.rollback({
      topology: 'full',
      instanceId: 'tenant-a',
      expectedGeneration: 2,
      expectedVersion: 'v2',
    });
    expect(rolledBack).toMatchObject({ generation: 3, currentVersion: 'v1', image: DIGEST_A });
    expect(mirroredConfig(harness)).toBe('{\n  "revision": 1\n}\n');
    expect(
      harness.fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container'),
    ).toContain(`Image=${DIGEST_A}`);
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v2')).toBe(true);
  });

  it('plans rollback only to the exact retained previous generation', async () => {
    const harness = await runningFull();
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B });
    await harness.manager.upgrade({
      topology: 'full',
      instanceId: 'tenant-a',
      expectedGeneration: 1,
      expectedVersion: 'v1',
      nextVersion: 'v2',
      nextImage: DIGEST_B,
      runtimeConfig: {},
      fullResources: FULL_RESOURCES,
    });
    await expect(
      harness.manager.planRollback({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 2,
        expectedVersion: 'v2',
      }),
    ).resolves.toMatchObject({ action: 'rollback', generation: 3, version: 'v1', destructive: true });
  });

  it('rejects stale generation/version fences before lifecycle mutation', async () => {
    const harness = await runningFull();
    const callsBefore = [...harness.systemd.calls];
    await expect(
      harness.manager.upgrade({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 2,
        expectedVersion: 'v1',
        nextVersion: 'v2',
        nextImage: DIGEST_B,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(harness.systemd.calls).toEqual(callsBefore);
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v2')).toBe(false);
  });

  it('restores the prior healthy version when the staged image fails health', async () => {
    const harness = await runningFull();
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B });
    harness.podman.unhealthyImages.add(DIGEST_B);
    await expect(
      harness.manager.upgrade({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        nextVersion: 'v2',
        nextImage: DIGEST_B,
        runtimeConfig: { revision: 2 },
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'health_failed' });

    expect(
      harness.fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container'),
    ).toContain(`Image=${DIGEST_A}`);
    expect(
      await harness.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).toMatchObject({ generation: 1, currentVersion: 'v1', image: DIGEST_A });
    expect(mirroredConfig(harness)).toBe('{\n  "revision": 1\n}\n');
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v1')).toBe(true);
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v2')).toBe(false);
  });

  it('restores the prior version if the atomic record commit fails', async () => {
    const harness = await runningFull();
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B });
    harness.fileSystem.failNextReplacePath =
      '/srv/manager-metadata/full/tenant-a/instance-record.json';
    await expect(
      harness.manager.upgrade({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        nextVersion: 'v2',
        nextImage: DIGEST_B,
        runtimeConfig: { revision: 2 },
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toThrow(/replace failure/);
    expect(
      harness.fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container'),
    ).toContain(`Image=${DIGEST_A}`);
    expect(
      await harness.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).toMatchObject({ generation: 1, currentVersion: 'v1', image: DIGEST_A });
    expect(mirroredConfig(harness)).toBe('{\n  "revision": 1\n}\n');
  });

  it('fails safely if the previous version cannot be restarted during recovery', async () => {
    const harness = await runningFull();
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B });
    harness.podman.unhealthyImages.add(DIGEST_B);
    harness.systemd.failStartImages.add(DIGEST_A);
    await expect(
      harness.manager.upgrade({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        nextVersion: 'v2',
        nextImage: DIGEST_B,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v2')).toBe(true);
  });
});
