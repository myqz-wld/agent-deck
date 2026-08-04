import {
  createImmutableOuterCeiling,
  validateFullApplianceManifest,
  type ApplianceMount,
  type FullApplianceManifest,
} from '@hosts/appliance';

import type { FullResourceSpec } from './types';
import { fullVolumeNames } from './paths';

export function validateFullVersionPolicy(input: {
  readonly instanceId: string;
  readonly image: string;
  readonly resources: FullResourceSpec;
}): void {
  const [state, workspace, socket, browser, secrets] = fullVolumeNames(input.instanceId);
  const mounts: readonly ApplianceMount[] = [
    {
      id: 'state',
      kind: 'named-volume',
      source: state,
      target: '/var/lib/agent-deck',
      access: 'read-write',
      purpose: 'state',
    },
    {
      id: 'workspace',
      kind: 'named-volume',
      source: workspace,
      target: '/workspaces',
      access: 'read-write',
      purpose: 'workspace',
    },
    {
      id: 'daemon-socket',
      kind: 'named-volume',
      source: socket,
      target: '/run/agent-deck',
      access: 'read-write',
      purpose: 'daemon-socket',
    },
    {
      id: 'browser-profile',
      kind: 'named-volume',
      source: browser,
      target: '/var/lib/agent-deck-browser',
      access: 'read-write',
      purpose: 'browser-profile',
    },
    {
      id: 'secrets',
      kind: 'named-volume',
      source: secrets,
      target: '/run/secrets',
      access: 'read-only',
      purpose: 'secret',
    },
  ];
  const resources = {
    cpuCores: input.resources.cpuCores,
    memoryBytes: input.resources.memoryBytes,
    pids: input.resources.pids,
    storageBytes: input.resources.rootfsBytes,
    logBytes: input.resources.logBytes,
  };
  const network = {
    publicEgress: ['dns', 'http', 'https'] as const,
    denyInbound: true as const,
    denyHostLoopback: true as const,
    denyPrivateNetworks: true as const,
    denyCloudMetadata: true as const,
    enforcement: 'verified-egress-gateway' as const,
  };
  const ceiling = createImmutableOuterCeiling({
    instanceId: input.instanceId,
    mounts,
    allowedBindSourceRoots: [],
    resources,
    network,
    allowDevices: false,
    allowPublishedPorts: false,
    allowEngineSocket: false,
    allowHostNetwork: false,
    allowPrivileged: false,
  });
  const socketPath = `/run/agent-deck/${input.instanceId}/agent-deckd.sock`;
  const manifest: FullApplianceManifest = {
    schemaVersion: 1,
    instanceId: input.instanceId,
    image: input.image,
    rootless: true,
    readOnlyRootFilesystem: true,
    privileged: false,
    hostNetwork: false,
    noNewPrivileges: true,
    droppedCapabilities: ['ALL'],
    addedCapabilities: [],
    devices: [],
    publishedPorts: [],
    mounts,
    resources,
    network: { ...network, name: `agent-deck-${input.instanceId}-egress` },
    controlSocket: { path: socketPath, mode: 0o600, published: false },
    healthCheck: {
      command: ['/opt/agent-deck/bin/agent-deckd', 'health', '--socket', socketPath],
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
    },
  };
  validateFullApplianceManifest(manifest, ceiling);
}
