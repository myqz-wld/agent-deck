import { describe, expect, it } from 'vitest';

import {
  createHarness,
  DIGEST_A,
  FULL_RESOURCES,
  seedEvidence,
} from './test-fixtures';

async function created() {
  const harness = createHarness();
  await harness.manager.create({
    topology: 'full',
    instanceId: 'tenant-a',
    version: 'v1',
    image: DIGEST_A,
    runtimeConfig: {},
    fullResources: FULL_RESOURCES,
  });
  return harness;
}

describe('LinuxInstanceManager tamper resistance', () => {
  it('rejects modified record envelopes and installed artifacts', async () => {
    const record = await created();
    const recordPath = '/srv/manager-metadata/full/tenant-a/instance-record.json';
    record.fileSystem.mutateFile(recordPath, record.fileSystem.readText(recordPath).replace('"v1"', '"v2"'));
    await expect(
      record.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });

    const unit = await created();
    const unitPath = '/srv/quadlet/agent-deck-full@tenant-a.container';
    unit.fileSystem.mutateFile(unitPath, `${unit.fileSystem.readText(unitPath)}# changed\n`);
    await expect(
      unit.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects changed manager artifact ownership and modes', async () => {
    const record = await created();
    record.fileSystem.mutateIdentity(
      '/srv/manager-metadata/full/tenant-a/instance-record.json',
      { mode: 0o644 },
    );
    await expect(
      record.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });

    const backup = await created();
    backup.fileSystem.mutateIdentity(
      '/srv/manager-backups/full/tenant-a/v1/agent-deck-full@.container',
      { uid: 0 },
    );
    await expect(
      backup.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects tampered systemd and Podman results', async () => {
    const systemd = await created();
    systemd.systemd.statusFragmentOverride = '/srv/quadlet/agent-deck-full@tenant-b.container';
    await expect(
      systemd.manager.status({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });

    const podman = await created();
    seedEvidence(podman, 'full', 'tenant-a');
    podman.podman.images.delete(DIGEST_A);
    await expect(
      podman.manager.start({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });
  });

  it('redacts command diagnostics and rejects truncated output', async () => {
    const harness = createHarness();
    harness.commands.failNext = true;
    let error: unknown;
    try {
      await harness.manager.create({
        topology: 'relay',
        instanceId: 'tenant-a',
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'command_failed' });
    expect(String(error)).not.toContain('secret output');
  });
});
