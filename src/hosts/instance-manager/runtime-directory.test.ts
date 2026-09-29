import { describe, expect, it } from 'vitest';

import { createHarness, DIGEST_A, seedEvidence } from './test-fixtures';

const selector = { topology: 'relay', instanceId: 'tenant-a' } as const;
const namespace = '/run/user/1001/agent-deck-relay';
const runtime = `${namespace}/tenant-a`;
const unit = 'agent-deck-relay@tenant-a.service';

async function missingRuntime(removeNamespace = false) {
  const harness = createHarness();
  await harness.manager.create({ ...selector, version: 'v1', image: DIGEST_A, runtimeConfig: {} });
  seedEvidence(harness, 'relay', 'tenant-a');
  await harness.fileSystem.removeTreeExact(
    await harness.fileSystem.captureTreeExact(removeNamespace ? namespace : runtime, 100),
  );
  harness.systemd.calls.length = 0;
  return harness;
}

describe('Relay ephemeral runtime directory recovery', () => {
  it('can inspect a rebooted instance without recreating runtime state', async () => {
    const harness = await missingRuntime(true);
    const before = harness.fileSystem.stateFingerprint();
    await expect(harness.manager.describe(selector)).resolves.toMatchObject({ currentVersion: 'v1' });
    await expect(harness.manager.status(selector)).resolves.toMatchObject({ systemd: { activeState: 'inactive' } });
    expect(harness.fileSystem.stateFingerprint()).toBe(before);
  });

  it.each([false, true])('recreates the exact private directory on start (namespace missing: %s)', async (removeNamespace) => {
    const harness = await missingRuntime(removeNamespace);
    harness.commands.beforeRuntimeRun = () => {
      expect(harness.fileSystem.exists(runtime)).toBe(true);
    };
    await expect(harness.manager.start(selector)).resolves.toMatchObject({ systemd: { activeState: 'active' } });
    for (const path of [namespace, runtime]) {
      expect(await harness.fileSystem.lstat(path)).toMatchObject({ kind: 'directory', mode: 0o700, uid: 1001 });
    }
    expect(harness.systemd.calls).toContain(`start:${unit}`);
  });

  it('stops only the exact retrying unit before runtime creation and preflight', async () => {
    const harness = await missingRuntime();
    harness.systemd.active.set(unit, 'activating');
    harness.commands.beforeRuntimeRun = () => {
      expect(harness.systemd.active.get(unit)).toBe('inactive');
      expect(harness.systemd.calls).toContain(`stop:${unit}`);
    };
    await harness.manager.start(selector);
    expect(harness.systemd.calls.filter((call) => call.startsWith('stop:'))).toEqual([`stop:${unit}`]);
  });

  it('does not recreate directories or stop services when acceptance evidence is stale', async () => {
    const harness = await missingRuntime();
    harness.setNow(1_000_000);
    await expect(harness.manager.start(selector)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.fileSystem.exists(runtime)).toBe(false);
    expect(harness.systemd.calls).toEqual([]);
  });

  it('does not repair an active service with unexpectedly missing runtime state', async () => {
    const harness = await missingRuntime();
    harness.systemd.active.set(unit, 'active');
    await expect(harness.manager.start(selector)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.fileSystem.exists(runtime)).toBe(false);
    expect(harness.systemd.calls).toEqual([`status:${unit}`]);
  });

  it.each([namespace, runtime])('rejects a symlink at %s without starting the service', async (path) => {
    const harness = await missingRuntime();
    harness.fileSystem.seedSymlink(path, '/srv/outside');
    await expect(harness.manager.start(selector)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.systemd.calls).toEqual([]);
  });

  it.each([{ mode: 0o777, uid: 1001 }, { mode: 0o700, uid: 0 }])('rejects an existing directory with unsafe identity %j', async ({ mode, uid }) => {
    const harness = await missingRuntime();
    harness.fileSystem.seedDirectory(runtime, mode, uid);
    await expect(harness.manager.start(selector)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.systemd.calls).toEqual([]);
  });
});
