import { describe, expect, it } from 'vitest';

import { LinuxInstanceManager } from './manager';
import { createHarness, DIGEST_A } from './test-fixtures';

const request = (instanceId: string) => ({
  topology: 'relay' as const,
  instanceId,
  version: 'v1',
  image: DIGEST_A,
  runtimeConfig: {},
});

describe('host instance leases', () => {
  it('excludes two manager objects on the same exact instance', async () => {
    const harness = createHarness();
    const second = new LinuxInstanceManager(harness.options);
    let started!: () => void;
    const paused = new Promise<void>((resolve) => { started = resolve; });
    harness.commands.pauseNext = started;
    const firstCreate = harness.manager.create(request('tenant-a'));
    await paused;
    let settled = false;
    const secondPlan = second.planCreate(request('tenant-a')).finally(() => { settled = true; });
    harness.setNow(10_000_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    harness.commands.resume();
    await firstCreate;
    await expect(secondPlan).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('allows independent instances to make progress concurrently', async () => {
    const harness = createHarness();
    const second = new LinuxInstanceManager(harness.options);
    let started!: () => void;
    const paused = new Promise<void>((resolve) => { started = resolve; });
    harness.commands.pauseNext = started;
    const first = harness.manager.create(request('tenant-a'));
    await paused;
    await expect(second.create(request('tenant-b'))).resolves.toMatchObject({ instanceId: 'tenant-b' });
    harness.commands.resume();
    await first;
  });

  it('releases the host lease when an operation throws', async () => {
    const harness = createHarness();
    const second = new LinuxInstanceManager(harness.options);
    harness.commands.failNext = true;
    await expect(harness.manager.create(request('tenant-a'))).rejects.toMatchObject({ code: 'command_failed' });
    await expect(second.planCreate(request('tenant-a'))).resolves.toMatchObject({ action: 'create' });
    expect(harness.leases.isHeld('relay:tenant-a')).toBe(false);
  });

  it('quarantines an invalid acquired handle before failing closed', async () => {
    const harness = createHarness();
    harness.leases.invalidNextHandle = { ownerToken: 'wrong-owner' };
    await expect(harness.manager.planCreate(request('tenant-a'))).rejects.toMatchObject({ code: 'lock_failed' });
    expect(harness.leases.quarantined).toHaveLength(1);
    expect(harness.leases.isHeld('relay:tenant-a')).toBe(false);
    await expect(harness.manager.planCreate(request('tenant-a'))).resolves.toMatchObject({ action: 'create' });
  });
});
