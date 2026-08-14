import type { BridgeAdmission } from '@protocol/index';
import {
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireStableToken,
} from '@hosts/linux-runtime/validation';
import { deriveConnectionScope } from '@hosts/linux-runtime/connection-scope';

export interface RelayForcedCommandBinding {
  readonly admission: BridgeAdmission;
  readonly socketPath: string;
  readonly expectedOriginalCommand: string;
}

export function resolveRelayForcedCommandBinding(
  role: 'client' | 'worker',
  flags: Readonly<Record<string, string>>,
  serviceUid: number,
): RelayForcedCommandBinding {
  if (!Number.isSafeInteger(serviceUid) || serviceUid <= 0) {
    throw new Error('Relay forced command requires a rootless service uid');
  }
  const instanceId = requireLinuxInstanceId(flags['--instance'], 'instance');
  const credentialId = requireStableToken(flags['--credential'], 'credential');
  const workerId = role === 'worker'
    ? requireStableToken(flags['--worker'], 'worker')
    : null;
  const surface = role === 'client'
    ? requireClientSurface(flags['--surface'])
    : null;
  const socketPath = requireAbsolutePath(flags['--socket'], 'socket');
  if (socketPath !== `/run/user/${serviceUid}/agent-deck-relay/${instanceId}/control.sock`) {
    throw new Error('Relay control socket is outside its exact service instance namespace');
  }
  const admission: BridgeAdmission = role === 'worker'
    ? {
        version: 2,
        topology: 'relay',
        role: 'worker',
        instanceId,
        credentialId,
        workerId: workerId as string,
      }
    : {
        version: 2,
        topology: 'relay',
        role: 'client',
        instanceId,
        credentialId,
        connectionScope: deriveConnectionScope(instanceId, credentialId),
        surface: surface as 'desktop' | 'feishu',
      };
  return Object.freeze({
    admission,
    socketPath,
    expectedOriginalCommand: role === 'worker'
      ? `agent-deck-relay attach --instance ${instanceId} --credential ${credentialId} --worker ${workerId}`
      : 'agent-deck-bridge',
  });
}

function requireClientSurface(
  value: string | undefined,
): 'desktop' | 'feishu' {
  if (value !== 'desktop' && value !== 'feishu') {
    throw new Error('Relay client surface is invalid');
  }
  return value;
}
