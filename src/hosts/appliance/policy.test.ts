import { describe, expect, it } from 'vitest';

import {
  AppliancePolicyError,
  createImmutableOuterCeiling,
  narrowSessionPolicy,
  type PublicEgressProtocol,
} from './policy';
import { outerCeilingFixture } from './outer-ceiling.fixture';

describe('immutable appliance outer ceiling', () => {
  it('deep-freezes explicit instance mounts, limits, and public-only network intent', () => {
    const ceiling = createImmutableOuterCeiling(outerCeilingFixture());
    expect(Object.isFrozen(ceiling)).toBe(true);
    expect(Object.isFrozen(ceiling.mounts)).toBe(true);
    expect(Object.isFrozen(ceiling.mounts[0])).toBe(true);
    expect(Object.isFrozen(ceiling.network.publicEgress)).toBe(true);
    expect(ceiling.network).toMatchObject({
      publicEgress: ['dns', 'http', 'https'],
      denyInbound: true,
      denyHostLoopback: true,
      denyPrivateNetworks: true,
      denyCloudMetadata: true,
      enforcement: 'verified-egress-gateway',
    });
  });

  it.each([
    '/',
    '/home/alice/project',
    '/root/agent-deck',
    '/Users/alice/project',
    '/dev',
    '/run/user/1200/podman/podman.sock',
    '/var/run/docker.sock',
  ])('rejects forbidden host bind source %s', (source) => {
    const baseline = outerCeilingFixture();
    const input = {
      ...baseline,
      mounts: baseline.mounts.map((mount) =>
        mount.purpose === 'workspace' ? { ...mount, kind: 'bind' as const, source } : mount,
      ),
      allowedBindSourceRoots: [source],
    };
    expect(() => createImmutableOuterCeiling(input)).toThrow(AppliancePolicyError);
  });

  it('rejects actual NUL characters in Linux mount and bind-root paths', () => {
    const baseline = outerCeilingFixture();
    expect(() =>
      createImmutableOuterCeiling({
        ...baseline,
        allowedBindSourceRoots: ['/srv/agent-deck/instances/tenant-a\0escape'],
      }),
    ).toThrow(/normalized absolute Linux path/);
    expect(() =>
      createImmutableOuterCeiling({
        ...baseline,
        mounts: baseline.mounts.map((mount) =>
          mount.purpose === 'workspace'
            ? { ...mount, target: '/workspaces\0escape' }
            : mount,
        ),
      }),
    ).toThrow(/normalized absolute Linux path/);
  });

  it('requires every named volume and bind root to be instance namespaced', () => {
    const baseline = outerCeilingFixture();
    const volumeInput = {
      ...baseline,
      mounts: baseline.mounts.map((mount) =>
        mount.purpose === 'state' ? { ...mount, source: 'agent-deck-other-state' } : mount,
      ),
    };
    expect(() => createImmutableOuterCeiling(volumeInput)).toThrow(/namespaced by instanceId/);

    const bindInput = {
      ...outerCeilingFixture(),
      allowedBindSourceRoots: ['/srv/agent-deck/instances/other'],
    };
    expect(() => createImmutableOuterCeiling(bindInput)).toThrow(/namespaced/);
  });

  it('rejects runtime values outside the closed mount and resource vocabularies', () => {
    const baseline = outerCeilingFixture();
    const invalidMount = {
      ...baseline,
      mounts: baseline.mounts.map((mount) =>
        mount.purpose === 'workspace' ? { ...mount, kind: 'host-magic' } : mount,
      ),
    } as unknown as Parameters<typeof createImmutableOuterCeiling>[0];
    expect(() => createImmutableOuterCeiling(invalidMount)).toThrow(/must be bind/);

    const ceiling = createImmutableOuterCeiling(baseline);
    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [{ target: '/workspaces', access: 'execute' }],
        publicEgress: [],
      } as unknown as Parameters<typeof narrowSessionPolicy>[1]),
    ).toThrow(/read-only or read-write/);
    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [],
        publicEgress: [],
        resources: { cpuCores: 1, burstCpuCores: 99 },
      } as unknown as Parameters<typeof narrowSessionPolicy>[1]),
    ).toThrow(/not a recognized limit/);
  });

  it('allows session policy to narrow but never widen mounts, egress, or resources', () => {
    const ceiling = createImmutableOuterCeiling(outerCeilingFixture());
    const effective = narrowSessionPolicy(ceiling, {
      mounts: [{ target: '/workspaces', access: 'read-only' }],
      publicEgress: ['https'],
      resources: { cpuCores: 1, memoryBytes: 2 * 1024 * 1024 * 1024, pids: 128 },
    });
    expect(effective).toMatchObject({
      mounts: [{ target: '/workspaces', access: 'read-only' }],
      publicEgress: ['https'],
      resources: { cpuCores: 1, memoryBytes: 2 * 1024 * 1024 * 1024, pids: 128 },
      allowDevices: false,
      allowPublishedPorts: false,
      allowEngineSocket: false,
    });

    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [{ target: '/run/secrets', access: 'read-write' }],
        publicEgress: [],
      }),
    ).toThrow(/widens read-only access/);
    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [{ target: '/host', access: 'read-only' }],
        publicEgress: [],
      }),
    ).toThrow(/absent from outer ceiling/);
    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [],
        publicEgress: ['ssh' as PublicEgressProtocol],
      }),
    ).toThrow(/subset of the ceiling/);
    expect(() =>
      narrowSessionPolicy(ceiling, {
        mounts: [],
        publicEgress: [],
        resources: { cpuCores: 5 },
      }),
    ).toThrow(/cannot exceed outer ceiling/);
  });
});
