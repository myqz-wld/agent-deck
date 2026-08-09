import { describe, expect, it } from 'vitest';

import { newJournal, writeJournal, type OperationJournal } from './journal';
import { generationPaths, resolveInstancePaths } from './paths';
import { canonicalJson, encodeJson, sha256 } from './serialization';
import { createHarness, DIGEST_A } from './test-fixtures';
import type { FileIdentity, InstanceRecord } from './types';

const unitDigest = '1'.repeat(64);
const configDigest = '2'.repeat(64);

function recordFor(paths: ReturnType<typeof resolveInstancePaths>): InstanceRecord {
  const generation = generationPaths(paths, 'v1');
  return {
    schemaVersion: 1, topology: 'relay', instanceId: 'tenant-a', generation: 1,
    currentVersion: 'v1', previousVersion: null, createdAtMs: 10_000, updatedAtMs: 10_000,
    versions: [{
      version: 'v1', image: DIGEST_A, unitSha256: unitDigest, configSha256: configDigest,
      unitBackupPath: generation.unitPath, configBackupPath: generation.configPath,
      fullResources: null, createdAtMs: 10_000,
    }],
  };
}

function createIntent(): OperationJournal {
  return newJournal({
    operationId: 'journal-test', operation: 'create', topology: 'relay', instanceId: 'tenant-a',
    expectedGeneration: 0, expectedVersion: null, phase: 'intent',
    target: { version: 'v1', image: DIGEST_A, unitSha256: unitDigest, configSha256: configDigest, record: null },
    previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
  });
}

describe('operation journal state-machine validation', () => {
  it('rejects an operation-incompatible phase on both encode and decode', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const invalid = { ...createIntent(), phase: 'healthy' } as unknown as OperationJournal;
    await expect(writeJournal(harness.options, paths, invalid, null)).rejects.toMatchObject({ code: 'tampered' });
    const envelope = { schemaVersion: 1, journal: invalid, sha256: sha256(canonicalJson(invalid)) };
    harness.fileSystem.seedFile(paths.journalPath, new TextDecoder().decode(encodeJson(envelope)), { mode: 0o600 });
    await expect(harness.manager.planCreate({ topology: 'relay', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {} })).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects a prepared target record outside its exact generation fence', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const target = { ...recordFor(paths), generation: 2 };
    const journal = { ...createIntent(), phase: 'prepared', target: { ...createIntent().target!, record: target } } as OperationJournal;
    await expect(writeJournal(harness.options, paths, journal, null)).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects a create intent that claims a staged target record', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const journal = { ...createIntent(), target: { ...createIntent().target!, record: recordFor(paths) } } as OperationJournal;
    await expect(writeJournal(harness.options, paths, journal, null)).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects duplicate paths and a path kind that disagrees with its identity', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const identity = harness.fileSystem.seedDirectory(paths.configDirectory);
    const duplicate = { path: paths.configDirectory, identity, kind: 'directory' as const };
    await expect(writeJournal(harness.options, paths, { ...createIntent(), createdPaths: [duplicate, duplicate] }, null)).rejects.toMatchObject({ code: 'tampered' });
    await expect(writeJournal(harness.options, paths, { ...createIntent(), createdPaths: [{ ...duplicate, kind: 'file' }] }, null)).rejects.toMatchObject({ code: 'tampered' });
  });

  it('uses the exact-tree validator for decoded removal snapshots', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const unitIdentity: FileIdentity = { device: 1, inode: 91, kind: 'file', mode: 0o444, uid: 1001, size: 1, modifiedAtMs: 10_000 };
    const rootIdentity: FileIdentity = { device: 1, inode: 92, kind: 'directory', mode: 0o700, uid: 1001, size: 0, modifiedAtMs: 10_000 };
    const badChild: FileIdentity = { device: 1, inode: 93, kind: 'symlink', mode: 0o777, uid: 1001, size: 1, modifiedAtMs: 10_000 };
    const journal = newJournal({
      operationId: 'bad-tree', operation: 'remove', topology: 'relay', instanceId: 'tenant-a',
      expectedGeneration: 1, expectedVersion: 'v1', phase: 'prepared', target: null,
      previousRecord: recordFor(paths), createdPaths: [{ path: paths.unitPath, identity: unitIdentity, kind: 'file' }],
      createdVolumes: [], removal: { deleteData: true, keepBackups: true, trees: [{ rootPath: paths.configDirectory, rootIdentity, entries: [{ relativePath: 'late-link', identity: badChild }] }], volumes: [] },
    });
    await expect(writeJournal(harness.options, paths, journal, null)).rejects.toMatchObject({ code: 'tampered' });
  });

  it('bounds the canonical envelope before creating its journal namespace', async () => {
    const harness = createHarness();
    const paths = resolveInstancePaths(harness.options.roots, 'relay', 'tenant-a');
    const context = { ...harness.options, limits: { ...harness.options.limits, maxArtifactBytes: 128 } };
    await expect(writeJournal(context, paths, createIntent(), null)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(harness.fileSystem.exists('/srv/manager-journals/relay')).toBe(false);
  });
});
