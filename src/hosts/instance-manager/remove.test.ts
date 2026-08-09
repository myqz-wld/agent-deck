import { describe, expect, it } from 'vitest';

import {
  createHarness,
  DIGEST_A,
  FULL_RESOURCES,
  seedEvidence,
} from './test-fixtures';

async function createStoppedFull() {
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

describe('LinuxInstanceManager remove', () => {
  it('requires stopped state and a token bound to exact choices and generation', async () => {
    const harness = await createStoppedFull();
    seedEvidence(harness, 'full', 'tenant-a');
    await harness.manager.start({ topology: 'full', instanceId: 'tenant-a' });
    await expect(
      harness.manager.planRemove({
        topology: 'full',
        instanceId: 'tenant-a',
        deleteData: true,
        keepBackups: true,
      }),
    ).rejects.toMatchObject({ code: 'not_stopped' });
    await harness.manager.stop({ topology: 'full', instanceId: 'tenant-a' });
    const plan = await harness.manager.planRemove({
      topology: 'full',
      instanceId: 'tenant-a',
      deleteData: true,
      keepBackups: true,
    });
    expect(plan.confirmationToken).toMatch(/^remove:full:tenant-a:1:[a-f0-9]{64}$/);

    await expect(
      harness.manager.remove({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        confirmationToken: plan.confirmationToken,
        deleteData: false,
        keepBackups: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(harness.fileSystem.exists(plan.unitPath)).toBe(true);
  });

  it('deletes selected data with fresh identities while retaining selected backups', async () => {
    const harness = await createStoppedFull();
    const plan = await harness.manager.planRemove({
      topology: 'full',
      instanceId: 'tenant-a',
      deleteData: true,
      keepBackups: true,
    });
    await harness.manager.remove({
      topology: 'full',
      instanceId: 'tenant-a',
      expectedGeneration: 1,
      expectedVersion: 'v1',
      confirmationToken: plan.confirmationToken,
      deleteData: true,
      keepBackups: true,
    });

    expect(harness.fileSystem.exists('/srv/quadlet/agent-deck-full@tenant-a.container')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-metadata/full/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.config/agent-deck/instances/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/run/user/1001/agent-deck/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-backups/full/tenant-a/v1')).toBe(true);
    expect(harness.podman.volumes.size).toBe(0);
  });

  it('preserves data and deletes backups only when those exact choices are confirmed', async () => {
    const harness = createHarness();
    await harness.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { retained: true },
    });
    const plan = await harness.manager.planRemove({
      topology: 'relay',
      instanceId: 'tenant-a',
      deleteData: false,
      keepBackups: false,
    });
    await harness.manager.remove({
      topology: 'relay',
      instanceId: 'tenant-a',
      expectedGeneration: 1,
      expectedVersion: 'v1',
      confirmationToken: plan.confirmationToken,
      deleteData: false,
      keepBackups: false,
    });
    expect(
      harness.fileSystem.exists(
        '/srv/agent-deck-user/.config/agent-deck-relay/tenant-a/config.json',
      ),
    ).toBe(true);
    expect(
      harness.fileSystem.exists('/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a'),
    ).toBe(true);
    expect(harness.fileSystem.exists('/run/user/1001/agent-deck-relay/tenant-a')).toBe(true);
    expect(harness.fileSystem.exists('/srv/manager-backups/relay/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-metadata/relay/tenant-a')).toBe(false);
  });

  it('rejects a token from another exact instance', async () => {
    const harness = createHarness();
    for (const instanceId of ['tenant-a', 'tenant-b']) {
      await harness.manager.create({
        topology: 'relay',
        instanceId,
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
      });
    }
    const planA = await harness.manager.planRemove({
      topology: 'relay',
      instanceId: 'tenant-a',
      deleteData: true,
      keepBackups: true,
    });
    await expect(
      harness.manager.remove({
        topology: 'relay',
        instanceId: 'tenant-b',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        confirmationToken: planA.confirmationToken,
        deleteData: true,
        keepBackups: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects an oversized confirmation token before decoding it', async () => {
    const harness = await createStoppedFull();
    await expect(harness.manager.remove({
      topology: 'full', instanceId: 'tenant-a', expectedGeneration: 1, expectedVersion: 'v1',
      confirmationToken: 'a'.repeat(1_000_000), deleteData: true, keepBackups: true,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(harness.fileSystem.exists('/srv/quadlet/agent-deck-full@tenant-a.container')).toBe(true);
  });

  it('preflights nested symlinks and changed volume identity before deleting anything', async () => {
    const relay = createHarness();
    await relay.manager.create({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: {},
    });
    relay.fileSystem.seedSymlink(
      '/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a/escape',
      '/srv',
    );
    const relayPlan = await relay.manager.planRemove({
      topology: 'relay',
      instanceId: 'tenant-a',
      deleteData: true,
      keepBackups: true,
    });
    await expect(
      relay.manager.remove({
        topology: 'relay',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        confirmationToken: relayPlan.confirmationToken,
        deleteData: true,
        keepBackups: true,
      }),
    ).rejects.toMatchObject({ code: 'tampered' });
    expect(relay.fileSystem.exists(relayPlan.unitPath)).toBe(true);

    const full = await createStoppedFull();
    const state = full.podman.volumes.get('agent-deck-tenant-a-state');
    if (!state) throw new Error('missing test volume');
    full.podman.volumes.set(state.name, {
      ...state,
      labels: { ...state.labels, 'io.agent-deck.instance': 'tenant-b' },
    });
    const fullPlan = await full.manager.planRemove({
      topology: 'full',
      instanceId: 'tenant-a',
      deleteData: true,
      keepBackups: true,
    });
    await expect(
      full.manager.remove({
        topology: 'full',
        instanceId: 'tenant-a',
        expectedGeneration: 1,
        expectedVersion: 'v1',
        confirmationToken: fullPlan.confirmationToken,
        deleteData: true,
        keepBackups: true,
      }),
    ).rejects.toMatchObject({ code: 'tampered' });
    expect(full.fileSystem.exists(fullPlan.unitPath)).toBe(true);
  });

  it('removes exact external evidence namespaces so a deleted id is not accidentally adopted', async () => {
    const harness = createHarness();
    await harness.manager.create({ topology: 'relay', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {} });
    seedEvidence(harness, 'relay', 'tenant-a');
    const plan = await harness.manager.planRemove({ topology: 'relay', instanceId: 'tenant-a', deleteData: true, keepBackups: false });
    await harness.manager.remove({ topology: 'relay', instanceId: 'tenant-a', expectedGeneration: 1, expectedVersion: 'v1', confirmationToken: plan.confirmationToken, deleteData: true, keepBackups: false });
    expect(harness.fileSystem.exists('/etc/agent-deck-relay/evidence/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/etc/agent-deck-manager/evidence/relay/tenant-a')).toBe(false);
    await expect(harness.manager.planCreate({ topology: 'relay', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {} })).resolves.toMatchObject({ action: 'create' });
  });
});
