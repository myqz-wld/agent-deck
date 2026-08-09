import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, DIGEST_A, FULL_RESOURCES, seedEvidence } from './test-fixtures';

function mirrorPath(harness: ReturnType<typeof createHarness>): string {
  const dataPath = harness.podman.volumeDataPaths.get('agent-deck-tenant-a-state');
  if (!dataPath) throw new Error('missing Full state volume data path');
  return posix.join(
    dataPath,
    'config/agent-deck/instances/tenant-a/config.json',
  );
}

describe('Full state-volume runtime config mirror', () => {
  it('installs the manager-owned config into the exact existing state volume', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { revision: 1 },
      fullResources: FULL_RESOURCES,
    });
    expect(harness.fileSystem.readText(mirrorPath(harness))).toBe('{\n  "revision": 1\n}\n');
    expect(await harness.fileSystem.lstat(mirrorPath(harness))).toMatchObject({
      kind: 'file',
      uid: 1001,
      mode: 0o600,
    });
  });

  it('fails closed before start when the volume copy no longer matches the record', async () => {
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
    harness.fileSystem.mutateFile(mirrorPath(harness), '{"revision":999}\n');
    const calls = [...harness.systemd.calls];
    await expect(harness.manager.start({
      topology: 'full',
      instanceId: 'tenant-a',
    })).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.systemd.calls).toEqual(calls);
  });

  it('fails create if the exact state-volume data directory changes during install', async () => {
    const harness = createHarness();
    harness.podman.afterResolveVolumeDataPath = (_volume, path, call) => {
      if (call === 2) harness.fileSystem.mutateIdentity(path, { inode: 999_999 });
    };
    await expect(harness.manager.create({
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { revision: 1 },
      fullResources: FULL_RESOURCES,
    })).rejects.toMatchObject({ code: 'tampered' });
  });
});
