import { isJsonValue, type ClientHello, type HostHello } from '@contracts/index';
import { negotiateProtocolVersion } from '@protocol/version';

import { errorMessage, SshTransportError } from './errors';
import { assertBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';

import type { SshHostProfile } from './types';

export function assertJsonSafeClientHello(hello: ClientHello): void {
  if (!isJsonValue(hello)) throw new Error('Client hello is not JSON-safe');
}

export function validateSshClientHello(
  profile: Readonly<SshHostProfile>,
  previous: ClientHello | null,
  hello: ClientHello,
): void {
  assertBoundedSingleLine(hello.clientId, 'hello.clientId', SSH_TEXT_LIMITS.clientId);
  if (hello.requestedTopology !== profile.topology) {
    throw new Error(`Profile topology does not match ${hello.requestedTopology}`);
  }
  if (
    previous &&
    (previous.clientId !== hello.clientId || previous.requestedTopology !== hello.requestedTopology)
  ) {
    throw new Error('One SSH client cannot change clientId or topology');
  }
}

export function asSshHandshakeError(error: unknown): SshTransportError {
  return new SshTransportError('incompatible_handshake', errorMessage(error), false, {
    cause: error,
  });
}

export function validateSshHostHello(
  profile: Readonly<SshHostProfile>,
  client: ClientHello,
  hello: HostHello,
  eventCursor: number,
): void {
  negotiateProtocolVersion(client.protocolVersion, hello.protocolVersion);
  assertBoundedSingleLine(hello.instanceId, 'hello.instanceId', SSH_TEXT_LIMITS.instanceId);
  assertBoundedSingleLine(
    hello.authoritativeCore.id,
    'hello.authoritativeCore.id',
    SSH_TEXT_LIMITS.coreId,
  );
  assertBoundedSingleLine(hello.access.clientId, 'hello.access.clientId', SSH_TEXT_LIMITS.clientId);
  if (hello.topology !== profile.topology) throw new Error('Host topology mismatch');
  const expectedSurface = profile.accessSurface ?? 'desktop-full';
  const expectedTransport = expectedSurface === 'desktop-full' ? 'ssh' : 'feishu';
  if (
    hello.access.kind !== 'authenticated-client' ||
    hello.access.transport !== expectedTransport ||
    hello.access.surface !== expectedSurface ||
    hello.access.clientId !== client.clientId
  ) {
    throw new Error('Host did not bind the requested SSH client identity');
  }
  if (profile.expectedInstanceId && hello.instanceId !== profile.expectedInstanceId) {
    throw new Error(`Expected instance ${profile.expectedInstanceId}`);
  }
  if (
    profile.expectedAccessCredentialId &&
    hello.access.accessCredentialId !== profile.expectedAccessCredentialId
  ) {
    throw new Error('Host access credential does not match the pinned SSH identity');
  }
  if (hello.eventRevision < eventCursor) {
    throw new SshTransportError('replay_gap', 'Host event revision is behind the client cursor');
  }
  if (new Set(hello.capabilities).size !== hello.capabilities.length) {
    throw new Error('Host hello contains duplicate capabilities');
  }
}
