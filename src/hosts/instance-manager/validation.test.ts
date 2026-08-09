import { describe, expect, it } from 'vitest';

import { LinuxInstanceManager } from './manager';
import { canonicalJson } from './serialization';
import { checkedNextGeneration } from './validation';
import {
  createHarness,
  DIGEST_A,
  FULL_RESOURCES,
} from './test-fixtures';

describe('LinuxInstanceManager validation and plans', () => {
  it.each([
    'registry.example/agent-deck:latest',
    `registry.example/agent-deck@sha256:${'A'.repeat(64)}`,
    `registry.example/agent-deck@sha512:${'a'.repeat(64)}`,
    `registry.example/agent deck@sha256:${'a'.repeat(64)}`,
    `-registry.example/repo@sha256:${'a'.repeat(64)}`,
    `registry.example/re%po@sha256:${'a'.repeat(64)}`,
    `registry.example/repo$HOME@sha256:${'a'.repeat(64)}`,
    `registry.example/repo//child@sha256:${'a'.repeat(64)}`,
    `registry.example/repo..child@sha256:${'a'.repeat(64)}`,
    `registry.example/repo@sha256:${'a'.repeat(64)}`,
  ])('rejects an unpinned or ambiguous image %j', async (image) => {
    const { manager } = createHarness();
    await expect(
      manager.planCreate({
        topology: 'relay',
        instanceId: 'tenant-a',
        version: 'v1',
        image,
        runtimeConfig: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it.each([
    '',
    '-tenant',
    'tenant-',
    'Tenant',
    'tenant_name',
    'tenant/name',
    'tenant..name',
    `tenant\u0000name`,
    'a'.repeat(64),
  ])('rejects unsafe instance id %j', async (instanceId) => {
    const { manager } = createHarness();
    await expect(
      manager.planCreate({
        topology: 'full',
        instanceId,
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('plans exact disjoint Full and Relay namespaces', async () => {
    const { manager } = createHarness();
    const full = await manager.planCreate({
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { topology: 'full' },
      fullResources: FULL_RESOURCES,
    });
    const relay = await manager.planCreate({
      topology: 'relay',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { topology: 'relay' },
    });

    expect(full.unitPath).toBe('/srv/quadlet/agent-deck-full@tenant-a.container');
    expect(relay.unitPath).toBe('/srv/quadlet/agent-deck-relay@tenant-a.container');
    expect(full.configPath).toBe(
      '/srv/agent-deck-user/.config/agent-deck/instances/tenant-a/config.json',
    );
    expect(relay.configPath).toBe(
      '/srv/agent-deck-user/.config/agent-deck-relay/tenant-a/config.json',
    );
    expect(full.runtimePath).not.toBe(relay.runtimePath);
    expect(full.containerControlSocketPath).toBe(
      '/run/agent-deck/tenant-a/agent-deckd.sock',
    );
    expect(full.hostControlSocketPath).toBeNull();
    expect(relay.hostControlSocketPath).toBe(
      '/run/user/1001/agent-deck-relay/tenant-a/control.sock',
    );
    expect(relay.containerControlSocketPath).toBe(
      '/run/agent-deck-relay/tenant-a/control.sock',
    );
    expect(full.metadataPath).not.toBe(relay.metadataPath);
    expect(full.backupPath).not.toBe(relay.backupPath);
    expect(full.evidencePaths).not.toEqual(relay.evidencePaths);
    expect(full.volumeNames).toHaveLength(5);
    expect(relay.volumeNames).toEqual([]);
    for (const plan of [full, relay]) {
      expect(plan.metadataPath).not.toBe(plan.configPath);
      expect(plan.backupPath).not.toBe(plan.runtimePath);
    }
  });

  it('provides a non-mutating list plan', async () => {
    const { manager } = createHarness();
    await expect(manager.planList()).resolves.toMatchObject({
      action: 'list',
      topology: null,
      instanceId: null,
      destructive: false,
    });
  });

  it('canonicalizes Unicode keys by deterministic code-point order', () => {
    const first = Object.fromEntries([['é', 1], ['z', 2], ['中', 3], ['a', 4]]);
    const second = Object.fromEntries([['中', 3], ['a', 4], ['é', 1], ['z', 2]]);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first).indexOf('"a"')).toBeLessThan(canonicalJson(first).indexOf('"z"'));
  });

  it('bounds runtime configuration cumulatively before encoding', async () => {
    const harness = createHarness();
    const runtimeConfig = Array.from({ length: 1_000 }, () => Array.from({ length: 20 }, () => 'x'));
    await expect(harness.manager.planCreate({ topology: 'relay', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects generation overflow and unsupported CPU precision', async () => {
    expect(() => checkedNextGeneration(Number.MAX_SAFE_INTEGER)).toThrow(/incremented safely/);
    const harness = createHarness();
    await expect(harness.manager.planCreate({
      topology: 'full', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A,
      runtimeConfig: {}, fullResources: { ...FULL_RESOURCES, cpuCores: 0.0000001 },
    })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('serializes accepted Full CPU values without exponent notation', async () => {
    const harness = createHarness();
    await harness.manager.create({ topology: 'full', instanceId: 'tenant-a', version: 'v1', image: DIGEST_A, runtimeConfig: {}, fullResources: { ...FULL_RESOURCES, cpuCores: 0.125 } });
    expect(harness.fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container')).toContain('--cpus=0.125 ');
  });

  it('rejects root, non-normalized, nested, and symlinked manager roots', async () => {
    const harness = createHarness();
    expect(
      () =>
        new LinuxInstanceManager({
          ...harness.options,
          roots: { ...harness.options.roots, metadataRoot: '/' },
        }),
    ).toThrow(/disjoint|normalized|root/i);

    expect(
      () =>
        new LinuxInstanceManager({
          ...harness.options,
          roots: { ...harness.options.roots, metadataRoot: '/srv/quadlet/metadata' },
        }),
    ).toThrow(/disjoint/);

    harness.fileSystem.seedSymlink('/srv/symlink-root', '/srv/manager-metadata');
    const manager = new LinuxInstanceManager({
      ...harness.options,
      roots: { ...harness.options.roots, metadataRoot: '/srv/symlink-root' },
    });
    await expect(manager.planList()).rejects.toMatchObject({ code: 'tampered' });
  });

  it('uses bounded argv arrays without shell command strings', async () => {
    const { manager, commands, fileSystem } = createHarness();
    await manager.create({
      topology: 'full',
      instanceId: 'tenant-a',
      version: 'v1',
      image: DIGEST_A,
      runtimeConfig: { mode: 'server-core' },
      fullResources: FULL_RESOURCES,
    });

    expect(commands.requests).toHaveLength(2);
    for (const request of commands.requests) {
      expect(request.executable).toBe('/usr/bin/bash');
      expect(Array.isArray(request.args)).toBe(true);
      expect(request.args).not.toContain('-c');
      expect(request.timeoutMs).toBe(60_000);
      expect(request.maxOutputBytes).toBe(16_384);
    }
    const unit = fileSystem.readText('/srv/quadlet/agent-deck-full@tenant-a.container');
    expect(unit).toContain(`Image=${DIGEST_A}`);
    expect(unit).not.toContain('@@');
    expect(unit).not.toContain('/srv/manager-metadata');
    expect(unit).not.toContain('/srv/manager-backups');
  });

  it.each([
    'PublishPort=22:22',
    'Network=host',
    'AddCapability=all',
    'Volume=/:/host:rw',
    'Volume=/run/podman/podman.sock:/run/podman/podman.sock:rw',
  ])('fails closed on a forbidden template directive %s', async (directive) => {
    const harness = createHarness();
    harness.fileSystem.mutateFile(
      harness.options.roots.fullTemplatePath,
      `${harness.fileSystem.readText(harness.options.roots.fullTemplatePath)}${directive}\n`,
    );
    await expect(
      harness.manager.create({
        topology: 'full',
        instanceId: 'tenant-a',
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
        fullResources: FULL_RESOURCES,
      }),
    ).rejects.toMatchObject({ code: 'tampered' });
  });

  it('fails closed on tampered preflight output', async () => {
    const second = createHarness();
    second.commands.tamperNextOutput = true;
    await expect(
      second.manager.create({
        topology: 'relay',
        instanceId: 'tenant-a',
        version: 'v1',
        image: DIGEST_A,
        runtimeConfig: {},
      }),
    ).rejects.toMatchObject({ code: 'command_failed' });
    expect(second.fileSystem.exists('/srv/quadlet/agent-deck-relay@tenant-a.container')).toBe(false);
  });
});
