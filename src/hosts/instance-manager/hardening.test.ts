import { describe, expect, it } from 'vitest';

import { LinuxInstanceManager } from './manager';
import { createHarness, DIGEST_A, seedEvidence } from './test-fixtures';

const relayRequest = {
  topology: 'relay' as const,
  instanceId: 'tenant-a',
  version: 'v1',
  image: DIGEST_A,
  runtimeConfig: {},
};

describe('namespace and trust hardening', () => {
  it.each([
    '/srv/agent-deck-user/.config/agent-deck-relay/tenant-a',
    '/srv/agent-deck-user/.local/share/agent-deck-relay/tenant-a',
    '/run/user/1001/agent-deck-relay/tenant-a',
    '/srv/manager-metadata/relay/tenant-a',
    '/srv/manager-backups/relay/tenant-a',
    '/etc/agent-deck-relay/evidence/tenant-a',
  ])('rejects a residual create namespace in plan and execution: %s', async (path) => {
    const planHarness = createHarness();
    planHarness.fileSystem.seedDirectoryChain(path);
    await expect(planHarness.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'already_exists' });
    const createHarnessCase = createHarness();
    createHarnessCase.fileSystem.seedDirectoryChain(path);
    await expect(createHarnessCase.manager.create(relayRequest)).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('rejects residual runtime files and one pre-existing Full volume', async () => {
    const runtime = createHarness();
    runtime.fileSystem.seedFile('/run/user/1001/agent-deck-relay/tenant-a/control.sock', 'residual');
    await expect(runtime.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'already_exists' });

    const volume = createHarness();
    await volume.podman.createVolume('agent-deck-tenant-a-state', {});
    await expect(volume.manager.planCreate({ ...relayRequest, topology: 'full', fullResources: { cpuCores: 1, memoryBytes: 1024, pids: 1, rootfsBytes: 1024, tmpfsBytes: 1, logBytes: 1 } })).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('rejects writable/wrong-owner roots and trusted artifacts', async () => {
    const rootMode = createHarness();
    rootMode.fileSystem.mutateIdentity(rootMode.options.roots.metadataRoot, { mode: 0o770 });
    await expect(rootMode.manager.planList()).rejects.toMatchObject({ code: 'tampered' });

    const templateOwner = createHarness();
    templateOwner.fileSystem.mutateIdentity(templateOwner.options.roots.fullTemplatePath, { uid: 1001 });
    await expect(templateOwner.manager.planList()).rejects.toMatchObject({ code: 'tampered' });

    const preflightMode = createHarness();
    preflightMode.fileSystem.mutateIdentity(preflightMode.options.roots.relayPreflightPath, { mode: 0o775 });
    await expect(preflightMode.manager.planList()).rejects.toMatchObject({ code: 'tampered' });
  });

  it('pins a trusted template across preflight execution', async () => {
    const harness = createHarness();
    harness.commands.beforeRun = () => harness.fileSystem.mutateFile(harness.options.roots.relayTemplatePath, 'changed\n');
    await expect(harness.manager.create(relayRequest)).rejects.toMatchObject({ code: 'command_failed' });
  });

  it('rejects a created directory whose backend returns the wrong owner/mode', async () => {
    const harness = createHarness();
    harness.fileSystem.nextDirectoryIdentityPatch = { uid: 0, mode: 0o755 };
    await expect(harness.manager.create(relayRequest)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(false);
  });

  it('rejects a generation directory whose trusted mode changed', async () => {
    const harness = createHarness();
    await harness.manager.create(relayRequest);
    harness.fileSystem.mutateIdentity('/srv/manager-backups/relay/tenant-a/v1', { mode: 0o770 });
    await expect(harness.manager.status({ topology: 'relay', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects a trusted input nested in a mutable namespace', () => {
    const harness = createHarness();
    expect(() => new LinuxInstanceManager({
      ...harness.options,
      roots: { ...harness.options.roots, fullTemplatePath: '/srv/manager-metadata/template' },
    })).toThrow(/outside manager namespaces/i);
  });

  it('allows the documented rootless unit root under serviceHome but rejects config aliasing', async () => {
    const harness = createHarness();
    const unitRoot = '/srv/agent-deck-user/.config/containers/systemd';
    harness.fileSystem.seedDirectoryChain(unitRoot);
    const manager = new LinuxInstanceManager({ ...harness.options, roots: { ...harness.options.roots, unitRoot } });
    await expect(manager.planList()).resolves.toMatchObject({ action: 'list' });
    expect(() => new LinuxInstanceManager({
      ...harness.options,
      roots: { ...harness.options.roots, unitRoot: '/srv/agent-deck-user/.config/agent-deck' },
    })).toThrow(/overlap/i);
  });

  it('surfaces a partial start plus failed stop as unrecovered cleanup', async () => {
    const harness = createHarness();
    await harness.manager.create(relayRequest);
    seedEvidence(harness, 'relay', 'tenant-a');
    harness.systemd.partialFailNextStart = true;
    harness.systemd.failNextStop = true;
    await expect(harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect(harness.systemd.active.get('agent-deck-relay@tenant-a.service')).toBe('active');
  });
});
