import { describe, expect, it } from 'vitest';

import {
  createHarness,
  DIGEST_A,
  FULL_RESOURCES,
  seedEvidence,
} from './test-fixtures';

describe('LinuxInstanceManager create and lifecycle', () => {
  it('creates, lists, starts, stops, and reports only exact instance units', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { topology: 'full' },
      fullResources: FULL_RESOURCES,
    });
    await harness.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { topology: 'relay' },
    });

    expect(await harness.manager.list()).toMatchObject([
      { topology: 'full', instanceId: 'tenant-a', currentVersion: 'v1' },
      { topology: 'relay', instanceId: 'tenant-a', currentVersion: 'v1' },
    ]);
    await expect(
      harness.manager.start({ topology: 'full', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });

    seedEvidence(harness, 'full', 'tenant-a');
    seedEvidence(harness, 'relay', 'tenant-a');
    await expect(
      harness.manager.planStart({ topology: 'full', instanceId: 'tenant-a' }),
    ).resolves.toMatchObject({ action: 'start', generation: 1, version: 'v1' });
    await expect(
      harness.manager.planStop({ topology: 'full', instanceId: 'tenant-a' }),
    ).resolves.toMatchObject({ action: 'stop', generation: 1, version: 'v1' });
    await expect(
      harness.manager.planStatus({ topology: 'full', instanceId: 'tenant-a' }),
    ).resolves.toMatchObject({ action: 'status', generation: 1, version: 'v1' });
    const full = await harness.manager.start({ topology: 'full', instanceId: 'tenant-a' });
    const relay = await harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' });
    expect(full.systemd.activeState).toBe('active');
    expect(relay.systemd.activeState).toBe('active');
    expect(harness.systemd.calls).toContain('start:agent-deck-full@tenant-a.service');
    expect(harness.systemd.calls).toContain('start:agent-deck-relay@tenant-a.service');
    expect(harness.systemd.calls.every((call) => !call.includes('target') && !call.includes('*'))).toBe(true);

    expect(
      (await harness.manager.stop({ topology: 'full', instanceId: 'tenant-a' })).systemd.activeState,
    ).toBe('inactive');
    expect(
      (await harness.manager.status({ topology: 'relay', instanceId: 'tenant-a' })).systemd.activeState,
    ).toBe('active');
  });

  it('requires fresh exact instance-bound egress and quota evidence', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
    });
    seedEvidence(harness, 'relay', 'tenant-a');
    harness.setNow(1_000_000);
    await expect(
      harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });

    harness.setNow(10_000);
    seedEvidence(harness, 'relay', 'tenant-a');
    harness.fileSystem.mutateFile(
      '/etc/agent-deck-relay/evidence/tenant-a/egress.env',
      'schemaVersion=1\ninstanceId=tenant-b\npublicOnlyEgressVerified=true\nprivateAndLinkLocalDenied=true\ncloudMetadataDenied=true\n',
    );
    await expect(
      harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tampered' });
  });

  it('cleans only resources created by a failed create after identity checks', async () => {
    const harness = createHarness();
    harness.commands.failNext = true;
    await expect(
      harness.manager.create({
        topology: 'full',
        instanceId: 'tenant-a',
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'command_failed' });

    expect(harness.fileSystem.exists('/srv/quadlet/agent-deck-full@tenant-a.container')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-metadata/full/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a')).toBe(false);
    expect(harness.podman.volumes.size).toBe(0);
    expect(harness.fileSystem.exists('/srv/agent-deck-user')).toBe(true);
  });

  it('rolls back files and volumes when failure occurs after resource creation', async () => {
    const harness = createHarness();
    harness.systemd.failNextReload = true;
    await expect(
      harness.manager.create({
        topology: 'full',
        instanceId: 'tenant-a',
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toThrow(/reload failed/);
    expect(harness.podman.volumes.size).toBe(0);
    expect(harness.fileSystem.exists('/srv/quadlet/agent-deck-full@tenant-a.container')).toBe(false);
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.config/agent-deck/instances/tenant-a')).toBe(false);
  });

  it('stops the exact unit if start reports a partial failure', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
    });
    seedEvidence(harness, 'relay', 'tenant-a');
    harness.systemd.failNextStart = true;
    await expect(
      harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' }),
    ).rejects.toThrow(/start failed/);
    expect(harness.systemd.calls.slice(-2)).toEqual([
      'stop:agent-deck-relay@tenant-a.service',
      'status:agent-deck-relay@tenant-a.service',
    ]);
  });

  it('serializes the same instance while allowing an independent instance to proceed', async () => {
    const harness = createHarness();
    for (const instanceId of ['tenant-a', 'tenant-b']) {
      await harness.manager.create({
        topology: 'relay',
        instanceId,
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
      });
      seedEvidence(harness, 'relay', instanceId);
    }
    let paused = false;
    harness.commands.pauseNext = () => {
      paused = true;
    };
    const first = harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paused).toBe(true);
    const same = harness.manager.status({ topology: 'relay', instanceId: 'tenant-a' });
    const independent = harness.manager.start({ topology: 'relay', instanceId: 'tenant-b' });
    await independent;
    expect(harness.systemd.calls).toContain('start:agent-deck-relay@tenant-b.service');
    expect(harness.systemd.calls).not.toContain('status:agent-deck-relay@tenant-a.service');
    harness.commands.resume();
    await first;
    await same;
    expect(harness.systemd.calls).toContain('status:agent-deck-relay@tenant-a.service');
  });
});
