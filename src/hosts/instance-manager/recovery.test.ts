import { describe, expect, it } from 'vitest';

import { atomicWrite } from './artifacts';
import { loadInstance } from './instance-reader';
import { newJournal, writeJournal } from './journal';
import { generationPaths, resolveInstancePaths } from './paths';
import { decodeRecord, sha256 } from './serialization';
import {
  createHarness,
  DIGEST_A,
  DIGEST_B,
  FULL_RESOURCES,
  seedEvidence,
} from './test-fixtures';
import type { InstanceRecord } from './types';
import { stageVersion } from './version-artifacts';

const relayRequest = { topology: 'relay' as const, instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {} };
const fullRequest = {
  topology: 'full' as const,
  instanceId: 'tenant-a',
  version: 'v1',
  image: DIGEST_A,
  runtimeConfig: { revision: 1 },
  fullResources: FULL_RESOURCES,
};

function createTargetRecord(paths: ReturnType<typeof resolveInstancePaths>, unitSha256: string, configSha256: string): InstanceRecord {
  const generation = generationPaths(paths, 'v1');
  return {
    schemaVersion: 1, topology: 'relay', instanceId: 'tenant-a', generation: 1,
    currentVersion: 'v1', previousVersion: null, createdAtMs: 10_000, updatedAtMs: 10_000,
    versions: [{
      version: 'v1', image: DIGEST_A, unitSha256, configSha256,
      unitBackupPath: generation.unitPath, configBackupPath: generation.configPath,
      fullResources: null, createdAtMs: 10_000,
    }],
  };
}

describe('durable operation recovery', () => {
  it('keeps every read and plan operation non-mutating when durable intent exists', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    await writeJournal(harness.options, paths, newJournal({
      operationId: 'crash-intent', operation: 'create', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: 'intent',
      target: { version: 'v1', image: DIGEST_A, unitSha256: '1'.repeat(64), configSha256: '2'.repeat(64), record: null },
      previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
    }), null);
    const reads = [
      () => harness.manager.planCreate(relayRequest),
      () => harness.manager.planStart(relayRequest),
      () => harness.manager.planStop(relayRequest),
      () => harness.manager.planStatus(relayRequest),
      () => harness.manager.planUpgrade({ ...relayRequest, expectedGeneration: 1, expectedVersion: 'v1', nextVersion: 'v2', nextImage: DIGEST_B, runtimeConfig: {} }),
      () => harness.manager.planRollback({ ...relayRequest, expectedGeneration: 1, expectedVersion: 'v1' }),
      () => harness.manager.planRemove({ ...relayRequest, deleteData: true, keepBackups: false }),
      () => harness.manager.status(relayRequest),
      () => harness.manager.list(),
    ];
    const fileState = harness.fileSystem.stateFingerprint();
    const volumes = JSON.stringify([...harness.podman.volumes]);
    const systemdCalls = [...harness.systemd.calls];
    for (const read of reads) {
      await expect(read()).rejects.toMatchObject({ code: 'recovery_required' });
      expect(harness.fileSystem.stateFingerprint()).toBe(fileState);
      expect(JSON.stringify([...harness.podman.volumes])).toBe(volumes);
      expect(harness.systemd.calls).toEqual(systemdCalls);
    }
    await expect(harness.manager.planList()).resolves.toMatchObject({ action: 'list' });
    expect(harness.fileSystem.stateFingerprint()).toBe(fileState);
    await expect(harness.manager.create(relayRequest)).resolves.toMatchObject({ instanceId: 'tenant-a' });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(false);
  });

  it.each([false, true])('cleans exact create artifacts after a crash with unit=%s', async (withUnit) => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    harness.fileSystem.seedDirectoryChain(paths.configDirectory);
    const directory = await harness.fileSystem.lstat(paths.configDirectory);
    if (!directory) throw new Error('missing directory');
    const configBytes = new TextEncoder().encode('{}\n');
    harness.fileSystem.seedFile(paths.configFile, '{}\n', { mode: 0o600 });
    const unitBytes = new TextEncoder().encode(`Image=${DIGEST_A}\n`);
    if (withUnit) harness.fileSystem.seedFile(paths.unitPath, new TextDecoder().decode(unitBytes), { mode: 0o444 });
    await writeJournal(harness.options, paths, newJournal({
      operationId: `crash-${withUnit ? 'unit' : 'config'}`, operation: 'create', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: withUnit ? 'unit_installing' : 'config_installing',
      target: { version: 'v1', image: DIGEST_A, unitSha256: sha256(unitBytes), configSha256: sha256(configBytes), record: createTargetRecord(paths, sha256(unitBytes), sha256(configBytes)) },
      previousRecord: null, createdPaths: [{ path: paths.configDirectory, identity: directory, kind: 'directory' }], createdVolumes: [], removal: null,
    }), null);
    const before = harness.fileSystem.stateFingerprint();
    await expect(harness.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.stateFingerprint()).toBe(before);
    await expect(harness.manager.create(relayRequest)).resolves.toMatchObject({ instanceId: 'tenant-a' });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(false);
  });

  it('adopts an exact committed create record and only clears its journal', async () => {
    const harness = createHarness();
    await harness.manager.create(relayRequest);
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const record = decodeRecord(await harness.fileSystem.readFile(paths.recordPath, 128_000));
    const current = record.versions[0];
    await writeJournal(harness.options, paths, newJournal({
      operationId: 'crash-record', operation: 'create', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: 'record_installing',
      target: { version: current.version, image: current.image, unitSha256: current.unitSha256, configSha256: current.configSha256, record },
      previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
    }), null);
    const before = harness.fileSystem.stateFingerprint();
    await expect(harness.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.stateFingerprint()).toBe(before);
    const reloads = harness.systemd.calls.filter((call) => call === 'reload').length;
    await expect(harness.manager.create(relayRequest)).rejects.toMatchObject({ code: 'already_exists' });
    expect(harness.systemd.calls.filter((call) => call === 'reload')).toHaveLength(reloads + 1);
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(false);
    expect(harness.fileSystem.exists(paths.recordPath)).toBe(true);
  });

  it.each(['reload', 'status'] as const)('preserves committed create recovery evidence on %s verification failure', async (failure) => {
    const harness = createHarness();
    await harness.manager.create(relayRequest);
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const record = decodeRecord(await harness.fileSystem.readFile(paths.recordPath, 128_000));
    const current = record.versions[0];
    await writeJournal(harness.options, paths, newJournal({
      operationId: `crash-record-${failure}`, operation: 'create', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: 'record_committed',
      target: { version: current.version, image: current.image, unitSha256: current.unitSha256, configSha256: current.configSha256, record },
      previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
    }), null);
    if (failure === 'reload') harness.systemd.failNextReload = true;
    else harness.systemd.statusFragmentOverride = '/wrong/unit.container';
    await expect(harness.manager.create(relayRequest)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(true);
    harness.systemd.statusFragmentOverride = null;
    await expect(harness.manager.create(relayRequest)).rejects.toMatchObject({ code: 'already_exists' });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(false);
  });

  it('preserves a Full create journal until the consumed state-volume config matches', async () => {
    const harness = createHarness();
    await harness.manager.create(fullRequest);
    const paths = resolveInstancePaths(harness.options.roots, 'full', 'tenant-a');
    const record = decodeRecord(await harness.fileSystem.readFile(paths.recordPath, 128_000));
    const current = record.versions[0];
    const dataPath = harness.podman.volumeDataPaths.get('agent-deck-tenant-a-state');
    if (!dataPath) throw new Error('missing Full state volume data path');
    const mirrorPath = `${dataPath}/config/agent-deck/instances/tenant-a/config.json`;
    const expectedConfig = harness.fileSystem.readText(current.configBackupPath);
    await writeJournal(harness.options, paths, newJournal({
      operationId: 'crash-full-record', operation: 'create', topology: 'full', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: 'record_committed',
      target: { version: current.version, image: current.image, unitSha256: current.unitSha256, configSha256: current.configSha256, record },
      previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
    }), null);
    harness.fileSystem.mutateFile(mirrorPath, '{"revision":"tampered"}\n');
    await expect(harness.manager.create(fullRequest)).rejects.toMatchObject({
      code: 'tampered',
    });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(true);
    harness.fileSystem.mutateFile(mirrorPath, expectedConfig);
    await expect(harness.manager.create(fullRequest)).rejects.toMatchObject({
      code: 'already_exists',
    });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(false);
  });

  it('fails closed on a checksum-tampered journal', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    await writeJournal(harness.options, paths, newJournal({
      operationId: 'tamper-journal', operation: 'create', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 0, expectedVersion: null, phase: 'intent',
      target: { version: 'v1', image: DIGEST_A, unitSha256: '1'.repeat(64), configSha256: '2'.repeat(64), record: null },
      previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
    }), null);
    harness.fileSystem.mutateFile(paths.journalPath, harness.fileSystem.readText(paths.journalPath).replace('"phase": "intent"', '"phase": "changed"'));
    await expect(harness.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'tampered' });
    expect(harness.fileSystem.exists(paths.journalPath)).toBe(true);
  });

  it('fails closed on an orphan from an interrupted atomic journal write', async () => {
    const harness = createHarness();
    harness.fileSystem.seedFile('/srv/manager-journals/relay/.tenant-a.journal.json.crashed.tmp', '{}\n', { mode: 0o600 });
    await expect(harness.manager.planCreate(relayRequest)).rejects.toMatchObject({ code: 'recovery_required' });
  });

  it.each(['config_installed', 'unit_installed'] as const)('requires manual recovery after %s without a healthy target', async (phase) => {
    const { harness } = await interruptedRelayCutover(phase);
    await expect(harness.manager.stop({ topology: 'relay', instanceId: 'tenant-a' })).rejects.toMatchObject({ code: 'recovery_required' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(true);
  });

  it('commits a health-gated target after a crash before record commit', async () => {
    const { harness } = await interruptedRelayCutover('healthy');
    await expect(harness.manager.stop({ topology: 'relay', instanceId: 'tenant-a' })).resolves.toMatchObject({ generation: 2, currentVersion: 'v2' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay/tenant-a.journal.json')).toBe(false);
  });
});

async function interruptedRelayCutover(phase: 'config_installed' | 'unit_installed' | 'healthy') {
  const harness = createHarness();
  await harness.manager.create(relayRequest);
  seedEvidence(harness, 'relay', 'tenant-a');
  await harness.manager.start({ topology: 'relay', instanceId: 'tenant-a' });
  const loaded = await loadInstance({ selector: relayRequest, roots: harness.options.roots, ports: harness.options.ports, maxArtifactBytes: harness.options.limits.maxArtifactBytes, serviceUid: harness.options.serviceUid });
  const staged = await stageVersion({ topology: 'relay', paths: loaded.paths, roots: harness.options.roots, ports: harness.options.ports, version: 'v2', image: DIGEST_B, runtimeConfig: { revision: 2 }, maxArtifactBytes: harness.options.limits.maxArtifactBytes, expectedUid: harness.options.serviceUid, trustedArtifactUid: harness.options.trustedArtifactUid });
  const nextRecord: InstanceRecord = { ...loaded.record, generation: 2, currentVersion: 'v2', previousVersion: 'v1', versions: [...loaded.record.versions, staged.version], updatedAtMs: harness.options.ports.clock.nowMs() };
  await harness.options.ports.systemd.stopUserUnit(loaded.paths.unitName, 10);
  const installedConfig = await atomicWrite(harness.fileSystem, loaded.paths.configFile, staged.configBytes, 0o600, loaded.configIdentity, 'crash-config-swap');
  let installedUnit = loaded.unitIdentity;
  if (phase !== 'config_installed') installedUnit = await atomicWrite(harness.fileSystem, loaded.paths.unitPath, staged.unitBytes, 0o444, loaded.unitIdentity, 'crash-unit-swap');
  if (phase === 'healthy') {
    seedEvidence(harness, 'relay', 'tenant-a', { generation: 2, version: 'v2', image: DIGEST_B });
    await harness.options.ports.systemd.daemonReload(10);
    await harness.options.ports.systemd.startUserUnit(loaded.paths.unitName, 10);
  }
  await writeJournal(harness.options, loaded.paths, newJournal({
    operationId: `crash-${phase}`, operation: 'upgrade', topology: 'relay', instanceId: 'tenant-a', expectedGeneration: 1, expectedVersion: 'v1', phase,
    target: { version: 'v2', image: DIGEST_B, unitSha256: staged.version.unitSha256, configSha256: staged.version.configSha256, record: nextRecord },
    previousRecord: loaded.record, createdPaths: [...staged.created], createdVolumes: [], removal: null,
  }), null);
  return { harness, installedConfig, installedUnit };
}
