import { describe, expect, it } from 'vitest';

import { validateFullApplianceManifest, type FullApplianceManifest } from './manifest';
import { outerCeilingFixture } from './outer-ceiling.fixture';

function manifest(): FullApplianceManifest {
  const ceiling = outerCeilingFixture();
  return {
    schemaVersion: 1,
    instanceId: ceiling.instanceId,
    image: `registry.example/agent-deck@sha256:${'a'.repeat(64)}`,
    rootless: true,
    readOnlyRootFilesystem: true,
    privileged: false,
    hostNetwork: false,
    noNewPrivileges: true,
    droppedCapabilities: ['ALL'],
    addedCapabilities: [],
    devices: [],
    publishedPorts: [],
    mounts: ceiling.mounts,
    resources: ceiling.resources,
    network: { ...ceiling.network, name: 'agent-deck-tenant-a-egress' },
    controlSocket: {
      path: '/run/agent-deck/tenant-a/agent-deckd.sock',
      mode: 0o600,
      published: false,
    },
    healthCheck: {
      command: [
        '/opt/agent-deck/bin/agent-deckd',
        'health',
        '--socket',
        '/run/agent-deck/tenant-a/agent-deckd.sock',
      ],
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
    },
  };
}

describe('full appliance manifest validator', () => {
  it('accepts a digest-pinned, rootless, private-socket manifest under the ceiling', () => {
    expect(() => validateFullApplianceManifest(manifest(), outerCeilingFixture())).not.toThrow();
  });

  it.each([
    ['published control port', { publishedPorts: ['0.0.0.0:47821:47821'] }],
    ['device passthrough', { devices: ['/dev/kvm'] }],
    ['host networking', { hostNetwork: true }],
    ['privileged execution', { privileged: true }],
    ['mutable image root', { readOnlyRootFilesystem: false }],
    ['added capability', { addedCapabilities: ['SYS_ADMIN'] }],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      validateFullApplianceManifest(
        { ...manifest(), ...patch } as FullApplianceManifest,
        outerCeilingFixture(),
      ),
    ).toThrow();
  });

  it('rejects an unpinned image and a published or misplaced control socket', () => {
    expect(() =>
      validateFullApplianceManifest(
        { ...manifest(), image: 'registry.example/agent-deck:latest' },
        outerCeilingFixture(),
      ),
    ).toThrow(/sha256-pinned/);
    expect(() =>
      validateFullApplianceManifest(
        {
          ...manifest(),
          controlSocket: {
            path: '/tmp/public.sock',
            mode: 0o600,
            published: false,
          },
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/private daemon socket/);
    expect(() =>
      validateFullApplianceManifest(
        {
          ...manifest(),
          controlSocket: {
            path: '/run/agent-deck/tenant-a/agent-deckd.sock',
            mode: 0o600,
            published: true,
          } as unknown as FullApplianceManifest['controlSocket'],
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/never published/);
  });

  it('rejects actual NUL characters in image and health command strings', () => {
    expect(() =>
      validateFullApplianceManifest(
        { ...manifest(), image: `${manifest().image}\0suffix` },
        outerCeilingFixture(),
      ),
    ).toThrow(/sha256-pinned/);
    expect(() =>
      validateFullApplianceManifest(
        {
          ...manifest(),
          healthCheck: {
            ...manifest().healthCheck,
            command: [...manifest().healthCheck.command, 'argument\0suffix'],
          },
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/argv-based/);
  });

  it('rejects mounts or resources broader than the immutable ceiling', () => {
    const broaderMounts = manifest().mounts.map((mount) =>
      mount.purpose === 'secret' ? { ...mount, access: 'read-write' as const } : mount,
    );
    expect(() =>
      validateFullApplianceManifest(
        { ...manifest(), mounts: broaderMounts },
        outerCeilingFixture(),
      ),
    ).toThrow(/broader than/);
    expect(() =>
      validateFullApplianceManifest(
        {
          ...manifest(),
          resources: { ...manifest().resources, memoryBytes: 32 * 1024 * 1024 * 1024 },
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/outer ceiling/);
  });

  it('rejects duplicate mounts or egress entries that conceal a required entry', () => {
    const baseline = manifest();
    const duplicateMounts = [...baseline.mounts];
    duplicateMounts[3] = duplicateMounts[0];
    expect(() =>
      validateFullApplianceManifest(
        { ...baseline, mounts: duplicateMounts },
        outerCeilingFixture(),
      ),
    ).toThrow(/duplicates/);

    expect(() =>
      validateFullApplianceManifest(
        {
          ...baseline,
          network: { ...baseline.network, publicEgress: ['dns', 'dns', 'http'] },
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/verified public DNS\/HTTP\(S\)-only/);
  });

  it('rejects ordinary rootless-network intent without verified enforcement semantics', () => {
    expect(() =>
      validateFullApplianceManifest(
        {
          ...manifest(),
          network: {
            ...manifest().network,
            enforcement: 'rootless-bridge-only',
          } as unknown as FullApplianceManifest['network'],
        },
        outerCeilingFixture(),
      ),
    ).toThrow(/verified public DNS\/HTTP\(S\)-only/);
  });
});
