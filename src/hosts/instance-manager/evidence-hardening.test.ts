import { describe, expect, it } from 'vitest';

import { createHarness, DIGEST_A, FULL_RESOURCES, seedEvidence } from './test-fixtures';

async function createdFull() {
  const harness = createHarness();
  await harness.manager.create({ topology: 'full', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {}, fullResources: FULL_RESOURCES });
  return harness;
}

describe('exact cutover evidence', () => {
  it('rejects evidence for an old or different generation', async () => {
    const harness = await createdFull();
    seedEvidence(harness, 'full', 'tenant-a', { generation: 2, version: 'v1' });
    await expect(harness.manager.start({ topology: 'full', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });

  it.each([
    ['unit digest', 'unitSha256=', `unitSha256=${'f'.repeat(64)}`],
    ['image', 'image=', `image=registry.example/other@sha256:${'f'.repeat(64)}`],
  ])('rejects evidence bound to another %s', async (_name, prefix, replacement) => {
    const harness = await createdFull();
    seedEvidence(harness, 'full', 'tenant-a');
    const path = '/etc/agent-deck-manager/evidence/full/tenant-a/1-v1/egress.env';
    const changed = harness.fileSystem.readText(path).split('\n').map((line) => line.startsWith(prefix) ? replacement : line).join('\n');
    harness.fileSystem.mutateFile(path, changed);
    await expect(harness.manager.start({ topology: 'full', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects evidence for different enforced quota/resource values', async () => {
    const harness = await createdFull();
    seedEvidence(harness, 'full', 'tenant-a', { fullResources: { ...FULL_RESOURCES, cpuCores: 3 } });
    await expect(harness.manager.start({ topology: 'full', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rechecks the exact evidence identity after topology preflight', async () => {
    const harness = await createdFull();
    seedEvidence(harness, 'full', 'tenant-a');
    const path = '/etc/agent-deck-manager/evidence/full/tenant-a/1-v1/egress.env';
    harness.commands.beforeRun = () => harness.fileSystem.mutateIdentity(path, { inode: 44_444 });
    await expect(harness.manager.start({ topology: 'full', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects an evidence directory owner/mode change', async () => {
    const harness = await createdFull();
    seedEvidence(harness, 'full', 'tenant-a');
    harness.fileSystem.mutateIdentity('/etc/agent-deck-manager/evidence/full/tenant-a/1-v1', { mode: 0o575 });
    await expect(harness.manager.start({ topology: 'full', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });
});
