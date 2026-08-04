import type { ApplianceMount, ApplianceOuterCeiling } from './policy';

function mounts(instanceId = 'tenant-a'): ApplianceMount[] {
  return [
    {
      id: 'state',
      kind: 'named-volume',
      source: `agent-deck-${instanceId}-state`,
      target: '/var/lib/agent-deck',
      access: 'read-write',
      purpose: 'state',
    },
    {
      id: 'workspace',
      kind: 'named-volume',
      source: `agent-deck-${instanceId}-workspace`,
      target: '/workspaces',
      access: 'read-write',
      purpose: 'workspace',
    },
    {
      id: 'daemon-socket',
      kind: 'named-volume',
      source: `agent-deck-${instanceId}-socket`,
      target: '/run/agent-deck',
      access: 'read-write',
      purpose: 'daemon-socket',
    },
    {
      id: 'browser-profile',
      kind: 'named-volume',
      source: `agent-deck-${instanceId}-browser`,
      target: '/var/lib/agent-deck-browser',
      access: 'read-write',
      purpose: 'browser-profile',
    },
    {
      id: 'secrets',
      kind: 'named-volume',
      source: `agent-deck-${instanceId}-secrets`,
      target: '/run/secrets',
      access: 'read-only',
      purpose: 'secret',
    },
  ];
}

export function outerCeilingFixture(): ApplianceOuterCeiling {
  return {
    instanceId: 'tenant-a',
    mounts: mounts(),
    allowedBindSourceRoots: ['/srv/agent-deck/instances/tenant-a'],
    resources: {
      cpuCores: 4,
      memoryBytes: 16 * 1024 * 1024 * 1024,
      pids: 1024,
      storageBytes: 100 * 1024 * 1024 * 1024,
      logBytes: 1024 * 1024 * 1024,
    },
    network: {
      publicEgress: ['dns', 'http', 'https'],
      denyInbound: true,
      denyHostLoopback: true,
      denyPrivateNetworks: true,
      denyCloudMetadata: true,
      enforcement: 'verified-egress-gateway',
    },
    allowDevices: false,
    allowPublishedPorts: false,
    allowEngineSocket: false,
    allowHostNetwork: false,
    allowPrivileged: false,
  };
}
