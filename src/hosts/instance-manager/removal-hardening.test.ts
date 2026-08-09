import { describe, expect, it } from 'vitest';

import { createHarness, DIGEST_A } from './test-fixtures';

async function stoppedRelay() {
  const harness = createHarness();
  await harness.manager.create({ topology: 'relay', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {} });
  harness.fileSystem.seedFile('/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a/payload', 'owned');
  return harness;
}

async function removalRequest(harness: Awaited<ReturnType<typeof stoppedRelay>>) {
  const plan = await harness.manager.planRemove({ topology: 'relay', instanceId: 'tenant-a', deleteData: true, keepBackups: false });
  return {
    topology: 'relay' as const,
    instanceId: 'tenant-a',
    expectedGeneration: 1,
    expectedVersion: 'v1',
    confirmationToken: plan.confirmationToken,
    deleteData: true,
    keepBackups: false,
  };
}

describe('descriptor-bound removal and tombstones', () => {
  it.each(['child-swap', 'late-symlink', 'late-extra', 'different-device'] as const)(
    'fails closed on %s after the exact snapshot',
    async (attack) => {
      const harness = await stoppedRelay();
      const request = await removalRequest(harness);
      const payload = '/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a/payload';
      harness.fileSystem.beforeRemoveTree = () => {
        if (attack === 'child-swap') harness.fileSystem.mutateIdentity(payload, { inode: 99_999 });
        if (attack === 'late-symlink') harness.fileSystem.mutateIdentity(payload, { kind: 'symlink' });
        if (attack === 'late-extra') harness.fileSystem.seedFile(`${payload}-extra`, 'late');
        if (attack === 'different-device') harness.fileSystem.mutateIdentity(payload, { device: 2 });
      };
      await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
      expect(harness.fileSystem.exists('/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a')).toBe(true);
      expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(true);
    },
  );

  it('continues an exact removal after one tree was already deleted', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    harness.fileSystem.failRemoveTreeAtPath = '/run/user/1001/agent-deck-relay/tenant-a';
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/run/user/1001/agent-deck-relay/tenant-a')).toBe(true);
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.fileSystem.exists('/srv/manager-metadata/relay/tenant-a')).toBe(false);
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(false);
  });

  it('continues safely after unit unlink/reload interruption', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    harness.systemd.afterReload = () => { throw new Error('simulated process interruption'); };
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists('/srv/quadlet/agent-deck-relay@tenant-a.container')).toBe(false);
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.config/agent-deck-relay/tenant-a')).toBe(true);
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.config/agent-deck-relay/tenant-a')).toBe(false);
  });

  it.each(['before', 'after'] as const)('continues safely after a crash %s exact unit unlink', async (point) => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    const unitPath = '/srv/quadlet/agent-deck-relay@tenant-a.container';
    if (point === 'before') harness.fileSystem.failRemoveFileAtPath = unitPath;
    else harness.fileSystem.afterRemoveFile = (path) => { if (path === unitPath) throw new Error('crash after unlink'); };
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(true);
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(false);
  });

  it('never deletes a replacement unit that appears after durable unlink', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    harness.systemd.afterReload = () => { throw new Error('crash during reload'); };
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    const unitPath = '/srv/quadlet/agent-deck-relay@tenant-a.container';
    harness.fileSystem.seedFile(unitPath, 'replacement\n', { mode: 0o444 });
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.readText(unitPath)).toBe('replacement\n');
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(true);
  });

  it('verifies complete tombstone absence before clearing recovery evidence', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    const journalPath = '/srv/manager-journals/relay/tenant-a.journal.json';
    harness.fileSystem.failRemoveFileAtPath = journalPath;
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.readText(journalPath)).toContain('"phase": "complete"');
    harness.fileSystem.seedDirectory('/srv/manager-metadata/relay/tenant-a', 0o700, 1001);
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists('/srv/manager-metadata/relay/tenant-a')).toBe(true);
    expect(harness.fileSystem.exists(journalPath)).toBe(true);
  });

  it('clears a complete tombstone only after all intended resources remain absent', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    const journalPath = '/srv/manager-journals/relay/tenant-a.journal.json';
    harness.fileSystem.failRemoveFileAtPath = journalPath;
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.fileSystem.exists(journalPath)).toBe(false);
  });

  it('rechecks inactive state after reload before deleting data', async () => {
    const harness = await stoppedRelay();
    const request = await removalRequest(harness);
    harness.systemd.afterReload = () => harness.systemd.active.set('agent-deck-relay@tenant-a.service', 'active');
    await expect(harness.manager.remove(request)).rejects.toMatchObject({ code: 'not_stopped' });
    expect(harness.fileSystem.exists('/srv/agent-deck-user/.config/agent-deck-relay/tenant-a/config.json')).toBe(true);
    expect(harness.systemd.active.get('agent-deck-relay@tenant-a.service')).toBe('inactive');
  });
});
