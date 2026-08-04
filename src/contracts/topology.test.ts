import { describe, expect, it } from 'vitest';

import {
  DeploymentTopology,
  getTopologyDescriptor,
  supportsRemoteAccess,
} from './topology';

describe('deployment topology contract', () => {
  it('keeps Standalone completely server-free', () => {
    const topology = getTopologyDescriptor(DeploymentTopology.Standalone);

    expect(topology).toMatchObject({
      authoritativeCoreLocation: 'local-process',
      accessTransports: ['local-ipc'],
      serverParticipates: false,
      serverExecutesAgents: false,
    });
    expect(supportsRemoteAccess(topology.topology)).toBe(false);
  });

  it('runs the authoritative Core on the server only in Server Core mode', () => {
    const topology = getTopologyDescriptor(DeploymentTopology.ServerCore);

    expect(topology).toMatchObject({
      authoritativeCoreLocation: 'server-appliance',
      accessTransports: ['ssh', 'feishu'],
      serverParticipates: true,
      serverExecutesAgents: true,
    });
  });

  it('keeps Relay computation on its local Worker', () => {
    const topology = getTopologyDescriptor(DeploymentTopology.Relay);

    expect(topology).toMatchObject({
      authoritativeCoreLocation: 'local-worker',
      accessTransports: ['ssh', 'feishu'],
      serverParticipates: true,
      serverExecutesAgents: false,
    });
  });
});
